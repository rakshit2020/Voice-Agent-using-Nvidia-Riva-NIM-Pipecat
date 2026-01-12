"""
MCP with NIM Voice Agent

A voice agent that integrates:
- Filesystem MCP Server (create, read, list, search, delete files)
- Web Search (via Serper API)
- Nvidia NIM services (STT, TTS, LLM)
"""

import os
import shutil
import aiohttp
import json
from dotenv import load_dotenv
from loguru import logger

from mcp import StdioServerParameters
from pipecat.services.mcp_service import MCPClient

from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    LLMRunFrame, 
    TTSSpeakFrame, 
    TranscriptionFrame, 
    TextFrame, 
    LLMFullResponseEndFrame, 
    Frame,
    OutputTransportMessageFrame
)
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.services.llm_service import FunctionCallParams
from pipecat.services.nvidia.llm import NvidiaLLMService
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.services.nvidia.stt import NvidiaSTTService
from pipecat.services.nvidia.tts import NvidiaTTSService

load_dotenv(override=True)

# Directory the filesystem MCP server can access
ALLOWED_DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class UserTranscriptSender(FrameProcessor):
    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):
            await self.push_frame(OutputTransportMessageFrame(message={
                "type": "transcription", 
                "text": frame.text
            }), direction)
        await self.push_frame(frame, direction)

class BotTranscriptSender(FrameProcessor):
    def __init__(self):
        super().__init__()
        self._text = ""

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        
        if isinstance(frame, TextFrame):
            self._text += frame.text
        elif isinstance(frame, LLMFullResponseEndFrame):
            if self._text:
                await self.push_frame(OutputTransportMessageFrame(message={
                    "type": "response",
                    "text": self._text
                }), direction)
                self._text = ""
                
        await self.push_frame(frame, direction)



async def search_web(params: FunctionCallParams):
    """Search the web using Serper API"""
    try:
        query = params.arguments.get("query")

        if not query:
            await params.result_callback({"error": "No query provided"})
            return

        url = "https://google.serper.dev/search"
        headers = {
            'X-API-KEY': os.getenv("SERPER_API_KEY"),
            'Content-Type': 'application/json'
        }
        payload = json.dumps({"q": query})

        async with aiohttp.ClientSession() as session:
            async with session.post(url, headers=headers, data=payload) as response:
                if response.status == 200:
                    data = await response.json()
                    results = []

                    # Get answer box if available
                    if "answerBox" in data:
                        answer = data["answerBox"].get("answer") or data["answerBox"].get("snippet")
                        if answer:
                            results.append(f"Answer: {answer}")

                    # Get organic results
                    if "organic" in data:
                        for i, result in enumerate(data["organic"][:3]):
                            title = result.get("title", "")
                            snippet = result.get("snippet", "")
                            results.append(f"{i+1}. {title}: {snippet}")

                    if results:
                        await params.result_callback({
                            "query": query,
                            "results": "\n\n".join(results)
                        })
                    else:
                        await params.result_callback({
                            "query": query,
                            "results": "No results found"
                        })
                else:
                    await params.result_callback({
                        "error": f"Search API returned status {response.status}"
                    })

    except Exception as e:
        logger.error(f"Web search error: {str(e)}")
        await params.result_callback({"error": f"Failed to search: {str(e)}"})


async def delete_file(params: FunctionCallParams):
    """Delete a file from the allowed directory"""
    try:
        file_path = params.arguments.get("path")

        if not file_path:
            await params.result_callback({"error": "No file path provided"})
            return

        # Security check: ensure the file is within the allowed directory
        abs_path = os.path.abspath(file_path)
        if not abs_path.startswith(ALLOWED_DIRECTORY):
            await params.result_callback({
                "error": f"Cannot delete files outside of {ALLOWED_DIRECTORY}"
            })
            return

        if not os.path.exists(abs_path):
            await params.result_callback({"error": f"File not found: {file_path}"})
            return

        if os.path.isdir(abs_path):
            await params.result_callback({"error": "Cannot delete directories, only files"})
            return

        # Delete the file
        os.remove(abs_path)
        logger.info(f"Deleted file: {abs_path}")
        await params.result_callback({
            "success": True,
            "message": f"Successfully deleted {os.path.basename(abs_path)}"
        })

    except Exception as e:
        logger.error(f"Delete file error: {str(e)}")
        await params.result_callback({"error": f"Failed to delete file: {str(e)}"})


# Transport configuration for WebRTC
transport_params = {
    "webrtc": lambda: TransportParams(
        audio_in_enabled=True,
        audio_out_enabled=True,
        vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.2)),
    ),
}


async def run_bot(transport: BaseTransport, runner_args: RunnerArguments):
    logger.info(f"Starting MCP with NIM Voice Agent")
    logger.info(f"Filesystem access allowed in: {ALLOWED_DIRECTORY}")

    # Initialize Nvidia NIM services
    stt = NvidiaSTTService(api_key=os.getenv("NVIDIA_API_KEY"))
    tts = NvidiaTTSService(api_key=os.getenv("NVIDIA_API_KEY"))
    llm = NvidiaLLMService(
        api_key=os.getenv("NVIDIA_API_KEY"),
        model="mistralai/devstral-2-123b-instruct-2512",
        params=NvidiaLLMService.InputParams(temperature=0.0),
    )

    # Initialize Filesystem MCP Client
    mcp_filesystem = MCPClient(
        server_params=StdioServerParameters(
            command=shutil.which("npx"),
            args=["-y", "@modelcontextprotocol/server-filesystem", ALLOWED_DIRECTORY],
        )
    )

    # Register MCP tools with the LLM (filesystem operations)
    mcp_tools = await mcp_filesystem.register_tools(llm)

    # Register custom functions manually
    llm.register_function("search_web", search_web)
    llm.register_function("delete_file", delete_file)

    @llm.event_handler("on_function_calls_started")
    async def on_function_calls_started(service, function_calls):
        # Provide feedback when tools are being used
        function_names = [fc.function_name for fc in function_calls]
        if "search_web" in function_names:
            await tts.queue_frame(TTSSpeakFrame("Let me search that for you."))
        elif "delete_file" in function_names:
            await tts.queue_frame(TTSSpeakFrame("Deleting the file."))
        else:
            await tts.queue_frame(TTSSpeakFrame("Processing your request."))

    # Define web search function schema
    web_search_function = FunctionSchema(
        name="search_web",
        description="IMMEDIATELY search the web when user asks about current events, facts, or requests a search. Required for any information you don't know.",
        properties={
            "query": {
                "type": "string",
                "description": "The search query to look up on the web.",
            },
        },
        required=["query"],
    )

    # Define delete file function schema
    delete_file_function = FunctionSchema(
        name="delete_file",
        description="Permanently delete a file from the filesystem. Use this when the user asks to delete or remove a file.",
        properties={
            "path": {
                "type": "string",
                "description": "The full path to the file to delete.",
            },
        },
        required=["path"],
    )

    # Combine MCP tools with custom functions
    all_tools = ToolsSchema(standard_tools=[web_search_function, delete_file_function])
    
    # Merge MCP tools if available
    if mcp_tools and mcp_tools.standard_tools:
        all_tools.standard_tools.extend(mcp_tools.standard_tools)

    # System prompt explaining capabilities
    system_prompt = f"""You are Sofia, Rakshit's advanced voice assistant in a real-time voice call.

RESPONSE FORMAT (CRITICAL):
- Use plain spoken language only
- No asterisks, markdown, emojis, or special characters
- Use "first, second, third" instead of bullet points
- Natural conversational tone

AVAILABLE TOOLS:
- File operations: read, create, list, search, delete files.
- Web search: search current information online
- File deletion: remove files from project directory {ALLOWED_DIRECTORY}

IMPORTANT: When user requests actions, USE the appropriate tool immediately. Confirm actions after completion in simple language.
EXAMPLES:
❌ WRONG: "Sure, I'll delete the file for you."
✅ CORRECT: [Call delete_file tool, then say] "File deleted successfully."

Start by introducing yourself briefly."""


    messages = [{"role": "system", "content": system_prompt}]

    context = LLMContext(messages, all_tools)
    context_aggregator = LLMContextAggregatorPair(context)

    pipeline = Pipeline([
        transport.input(),
        stt,
        UserTranscriptSender(),
        context_aggregator.user(),
        llm,
        BotTranscriptSender(),
        tts,
        transport.output(),
        context_aggregator.assistant(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        idle_timeout_secs=runner_args.pipeline_idle_timeout_secs,
    )

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected")
        await task.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected")
        await task.cancel()

    runner = PipelineRunner(handle_sigint=runner_args.handle_sigint)
    await runner.run(task)


async def bot(runner_args: RunnerArguments):
    """Main bot entry point compatible with Pipecat Cloud."""
    transport = await create_transport(runner_args, transport_params)
    await run_bot(transport, runner_args)


if __name__ == "__main__":
    from pipecat.runner.run import main
    main()
