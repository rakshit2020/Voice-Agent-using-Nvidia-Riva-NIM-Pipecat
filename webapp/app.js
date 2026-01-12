/**
 * Voice Agent Web Client
 * Connects to Pipecat voice agent using SmallWebRTC transport
 */

// Configuration
const CONFIG = {
    botUrl: 'http://localhost:7860',
    autoConnect: false,
};

// State
let peerConnection = null;
let localStream = null;
let remoteAudio = null;
let dataChannel = null;
let isConnected = false;
let isMuted = false;
let volume = 0.8;

// DOM Elements
const connectBtn = document.getElementById('connectBtn');
const muteBtn = document.getElementById('muteBtn');
const volumeSlider = document.getElementById('volumeSlider');
const volumeValue = document.getElementById('volumeValue');
const statusBadge = document.getElementById('statusBadge');
const voiceOrb = document.getElementById('voiceOrb');
const orbStatus = document.getElementById('orbStatus');
const conversationContainer = document.getElementById('conversationContainer');
const clearBtn = document.getElementById('clearBtn');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    createRemoteAudio();
});

function setupEventListeners() {
    connectBtn.addEventListener('click', toggleConnection);
    muteBtn.addEventListener('click', toggleMute);
    volumeSlider.addEventListener('input', handleVolumeChange);
    clearBtn.addEventListener('click', clearConversation);
}

function createRemoteAudio() {
    remoteAudio = document.createElement('audio');
    remoteAudio.autoplay = true;
    remoteAudio.volume = volume;
    document.body.appendChild(remoteAudio);
}

// ===== Connection Management =====

async function toggleConnection() {
    if (isConnected) {
        disconnect();
    } else {
        await connect();
    }
}

async function connect() {
    try {
        updateUI('connecting');

        // Get user media (microphone)
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
            video: false
        });

        // Create peer connection
        peerConnection = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        // Add local audio track
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });

        // Handle remote audio
        peerConnection.ontrack = (event) => {
            console.log('Received remote track');
            remoteAudio.srcObject = event.streams[0];

            // Analyze audio for speaking detection
            setupAudioAnalyzer(event.streams[0]);
        };

        // Handle ICE candidates
        peerConnection.onicecandidate = (event) => {
            // ICE candidates are gathered and sent with the offer
        };

        // Connection state changes
        peerConnection.onconnectionstatechange = () => {
            console.log('Connection state:', peerConnection.connectionState);
            if (peerConnection.connectionState === 'connected') {
                updateUI('connected');
                addSystemMessage('Connected to voice agent');
            } else if (peerConnection.connectionState === 'disconnected' ||
                peerConnection.connectionState === 'failed') {
                disconnect();
            }
        };

        // Create data channel for messages
        dataChannel = peerConnection.createDataChannel('chat');
        dataChannel.onmessage = handleDataChannelMessage;
        dataChannel.onopen = () => console.log('Data channel open');

        // Create and send offer
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        // Wait for ICE gathering
        await waitForIceGathering();

        // Send offer to server
        // Endpoint identified as /api/offer via probing
        const response = await fetch(`${CONFIG.botUrl}/api/offer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sdp: peerConnection.localDescription.sdp,
                type: peerConnection.localDescription.type,
            }),
        });

        if (!response.ok) {
            throw new Error(`Server error: ${response.status}`);
        }

        const answer = await response.json();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));

        isConnected = true;
        updateUI('connected');

    } catch (error) {
        console.error('Connection error:', error);
        addSystemMessage(`Connection failed: ${error.message}`);
        disconnect();
    }
}

function waitForIceGathering() {
    return new Promise((resolve) => {
        if (peerConnection.iceGatheringState === 'complete') {
            resolve();
        } else {
            const checkState = () => {
                if (peerConnection.iceGatheringState === 'complete') {
                    peerConnection.removeEventListener('icegatheringstatechange', checkState);
                    resolve();
                }
            };
            peerConnection.addEventListener('icegatheringstatechange', checkState);
            // Timeout fallback
            setTimeout(resolve, 2000);
        }
    });
}

function disconnect() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    if (dataChannel) {
        dataChannel.close();
        dataChannel = null;
    }

    isConnected = false;
    updateUI('disconnected');
    addSystemMessage('Disconnected from voice agent');
}

// ===== Audio Analysis (Speaking Detection) =====

let audioContext = null;
let analyser = null;
let speakingCheckInterval = null;

function setupAudioAnalyzer(stream) {
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;

        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        // Check audio levels periodically
        speakingCheckInterval = setInterval(() => {
            analyser.getByteFrequencyData(dataArray);
            const average = dataArray.reduce((a, b) => a + b) / dataArray.length;

            if (average > 20) {
                setOrbState('speaking');
            } else if (isConnected) {
                setOrbState('listening');
            }
        }, 100);

    } catch (error) {
        console.error('Audio analyzer setup failed:', error);
    }
}

function cleanupAudioAnalyzer() {
    if (speakingCheckInterval) {
        clearInterval(speakingCheckInterval);
        speakingCheckInterval = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
}

// ===== UI Updates =====

function updateUI(state) {
    switch (state) {
        case 'connecting':
            statusBadge.textContent = 'Connecting...';
            statusBadge.className = 'status-badge connecting';
            connectBtn.className = 'btn-connect connecting';
            connectBtn.querySelector('.btn-text').textContent = 'Connecting...';
            connectBtn.querySelector('.btn-icon').textContent = '⏳';
            setOrbState('idle');
            orbStatus.textContent = 'Connecting...';
            break;

        case 'connected':
            statusBadge.textContent = 'Connected';
            statusBadge.className = 'status-badge connected';
            connectBtn.className = 'btn-connect connected';
            connectBtn.querySelector('.btn-text').textContent = 'Disconnect';
            connectBtn.querySelector('.btn-icon').textContent = '🔌';
            muteBtn.disabled = false;
            volumeSlider.disabled = false;
            setOrbState('listening');
            orbStatus.textContent = 'Listening...';
            break;

        case 'disconnected':
            statusBadge.textContent = 'Disconnected';
            statusBadge.className = 'status-badge';
            connectBtn.className = 'btn-connect';
            connectBtn.querySelector('.btn-text').textContent = 'Connect';
            connectBtn.querySelector('.btn-icon').textContent = '🎤';
            muteBtn.disabled = true;
            volumeSlider.disabled = true;
            setOrbState('idle');
            orbStatus.textContent = 'Click connect to start';
            cleanupAudioAnalyzer();
            break;
    }
}

function setOrbState(state) {
    voiceOrb.className = `orb ${state}`;

    if (state === 'speaking') {
        orbStatus.textContent = 'Speaking...';
    } else if (state === 'listening') {
        orbStatus.textContent = 'Listening...';
    }
}

// ===== Controls =====

function toggleMute() {
    if (!localStream) return;

    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
    });

    muteBtn.querySelector('.icon').textContent = isMuted ? '🔇' : '🔊';
    muteBtn.querySelector('.label').textContent = isMuted ? 'Unmute' : 'Mute';
    muteBtn.classList.toggle('muted', isMuted);
}

function handleVolumeChange(event) {
    volume = event.target.value / 100;
    volumeValue.textContent = `${event.target.value}%`;

    if (remoteAudio) {
        remoteAudio.volume = volume;
    }
}

// ===== Conversation =====

function handleDataChannelMessage(event) {
    try {
        const data = JSON.parse(event.data);

        if (data.type === 'transcription') {
            addMessage('user', data.text);
        } else if (data.type === 'response') {
            addMessage('bot', data.text);
        }
    } catch (error) {
        console.log('Data channel message:', event.data);
    }
}

function addMessage(sender, text) {
    // Remove welcome message if present
    const welcome = conversationContainer.querySelector('.welcome-message');
    if (welcome) {
        welcome.remove();
    }

    const messageEl = document.createElement('div');
    messageEl.className = `message ${sender}`;

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    messageEl.innerHTML = `
        <div class="sender">${sender === 'user' ? 'You' : 'Agent'}</div>
        <div class="text">${escapeHtml(text)}</div>
        <div class="timestamp">${time}</div>
    `;

    conversationContainer.appendChild(messageEl);
    scrollToBottom();
}

function addSystemMessage(text) {
    const messageEl = document.createElement('div');
    messageEl.className = 'message bot';
    messageEl.style.opacity = '0.7';
    messageEl.style.fontStyle = 'italic';

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    messageEl.innerHTML = `
        <div class="text">ℹ️ ${escapeHtml(text)}</div>
        <div class="timestamp">${time}</div>
    `;

    conversationContainer.appendChild(messageEl);
    scrollToBottom();
}

function clearConversation() {
    conversationContainer.innerHTML = `
        <div class="welcome-message">
            <p>👋 Welcome! Connect to start talking with the voice agent.</p>
            <p class="hint">The agent can search the web, manage files, and have natural conversations.</p>
        </div>
    `;
}

function scrollToBottom() {
    requestAnimationFrame(() => {
        conversationContainer.scrollTop = conversationContainer.scrollHeight;
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ===== Cleanup =====

window.addEventListener('beforeunload', () => {
    if (isConnected) {
        disconnect();
    }
});
