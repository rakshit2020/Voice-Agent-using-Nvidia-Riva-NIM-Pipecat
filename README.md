# Ultra Low Latency Voice Agent using Nvidia Riva, NIM and Pipecat

An ultra-low latency voice assistant built with **Pipecat** using **NVIDIA Riva** and **NVIDIA NIM** models. This everyday AI assistant helps you manage your project directory, create documentation, search the web, and handle file operations all through natural voice conversation.

The agent features a custom interactive web interface and leverages **MCP (Model Context Protocol)** tools for seamless file system access and Google Search integration via Serper API.

---

##  Demo

> **[Demo Video Coming Soon]**  
> 

---

##  Architecture

> 
> <img width="2752" height="1536" alt="VoiceAgent" src="https://github.com/user-attachments/assets/197b3da1-fdb2-4a5f-981b-95dbe0d72130" />


---

##  Installation

### 1. Clone the Repository

```bash
git clone https://github.com/rakshit2020/Voice-Agent-using-Nvidia-Riva-NIM-Pipecat.git
cd Voice-Agent-using-Nvidia-Riva-NIM-Pipecat
```

### 2. Install Dependencies with `uv`

```bash
uv sync
```

This will automatically create a virtual environment and install all required packages from `pyproject.toml`.

### 3. Configure Environment Variables

Create a `.env` file in the project root:

```env
NVIDIA_API_KEY=your_nvidia_api_key_here
SERPER_API_KEY=your_serper_api_key_here
```

Get your API keys:
- **NVIDIA API Key**: [build.nvidia.com](https://build.nvidia.com)
- **Serper API Key**: [serper.dev](https://serper.dev)

---

##  Running the Voice Agent

### 1. Start the Voice Agent Backend

```bash
python mcp_with_nim_webapp.py
```

The backend will start on `http://localhost:7860`.

### 2. Start the Web Interface

Open a new terminal and navigate to the `webpage` folder:

```bash
cd webpage
python -m http.server 8080
```

### 3. Access the Voice Agent

Open your browser and go to:

```
http://localhost:8080
```

Click **Connect** and start talking to your voice assistant!

---

##  What You Can Ask

- "Search the web for the latest NVIDIA announcements and save them to a file"
- "List all files in the current directory"
- "Create a new file called meeting-notes.txt with today's summary"
- "Read the contents of README.md"
- "Delete the temporary files"

---

## ⭐ Show Your Support

If you find this project helpful, please give it a **star** on GitHub!

---

**Built with ❤️ using NVIDIA Riva, NVIDIA NIM, and Pipecat**
