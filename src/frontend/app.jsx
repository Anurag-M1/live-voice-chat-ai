const { useRef, useEffect, useState } = React;

const getModalDerivedEndpoint = () => {
  // use current web app server domain to construct the url for the moshi app
  const currentURL = new URL(window.location.href);
  let hostname = currentURL.hostname;
  hostname = hostname.replace("-web", "-moshi-web");
  const wsProtocol = currentURL.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${hostname}/ws`;
};

const resolveWebSocketEndpoint = () => {
  const params = new URLSearchParams(window.location.search);
  const queryEndpoint = params.get("ws");
  if (queryEndpoint) {
    return queryEndpoint;
  }
  if (
    window.LIVE_VOICE_WS_ENDPOINT &&
    window.LIVE_VOICE_WS_ENDPOINT.trim().length > 0
  ) {
    return window.LIVE_VOICE_WS_ENDPOINT.trim();
  }
  if (window.location.hostname.includes("-web")) {
    return getModalDerivedEndpoint();
  }
  return "";
};

const getEndpointLabel = (endpoint) => {
  if (!endpoint) {
    return "Not set";
  }
  try {
    const url = new URL(endpoint);
    return url.host;
  } catch (error) {
    return "Invalid";
  }
};

const App = () => {
  // Mic Input
  const [recorder, setRecorder] = useState(null); // Opus recorder
  const [amplitude, setAmplitude] = useState(0); // Amplitude, captured from PCM analyzer

  // Audio playback
  const [audioContext] = useState(
    () => new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 })
  );
  const sourceNodeRef = useRef(null); // Audio source node
  const scheduledEndTimeRef = useRef(0); // Scheduled end time for audio playback
  const decoderRef = useRef(null); // Decoder for converting opus to PCM

  // WebSocket
  const socketRef = useRef(null); // Ongoing websocket connection

  // UI State
  const [warmupComplete, setWarmupComplete] = useState(false);
  const [completedSentences, setCompletedSentences] = useState([]);
  const [pendingSentence, setPendingSentence] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [errorMessage, setErrorMessage] = useState("");
  const [wsEndpoint] = useState(() => resolveWebSocketEndpoint());
  const endpointLabel = getEndpointLabel(wsEndpoint);

  // Mic Input: start the Opus recorder
  const startRecording = async () => {
    try {
      // prompts user for permission to use microphone
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const recorderInstance = new Recorder({
        encoderPath:
          "https://cdn.jsdelivr.net/npm/opus-recorder@latest/dist/encoderWorker.min.js",
        streamPages: true,
        encoderApplication: 2049,
        encoderFrameSize: 80, // milliseconds, equal to 1920 samples at 24000 Hz
        encoderSampleRate: 24000, // 24000 to match model's sample rate
        maxFramesPerPage: 1,
        numberOfChannels: 1,
      });

      recorderInstance.ondataavailable = async (arrayBuffer) => {
        if (socketRef.current) {
          if (socketRef.current.readyState !== WebSocket.OPEN) {
            console.log("Socket not open, dropping audio");
            return;
          }
          await socketRef.current.send(arrayBuffer);
        }
      };

      recorderInstance.start().then(() => {
        console.log("Recording started");
        setRecorder(recorderInstance);
      });

      // create a MediaRecorder object for capturing PCM (calculating amplitude)
      const analyzerContext = new (window.AudioContext || window.webkitAudioContext)();
      const analyzer = analyzerContext.createAnalyser();
      analyzer.fftSize = 256;
      const sourceNode = analyzerContext.createMediaStreamSource(stream);
      sourceNode.connect(analyzer);

      // Use a separate audio processing function instead of MediaRecorder
      const processAudio = () => {
        const dataArray = new Uint8Array(analyzer.frequencyBinCount);
        analyzer.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
        setAmplitude(average);
        requestAnimationFrame(processAudio);
      };
      processAudio();
    } catch (error) {
      console.error("Mic access error:", error);
      setErrorMessage("Microphone access is blocked. Please allow microphone permissions.");
    }
  };

  // Audio Playback: Prep decoder for converting opus to PCM for audio playback
  useEffect(() => {
    const initializeDecoder = async () => {
      const decoder = new window["ogg-opus-decoder"].OggOpusDecoder();
      await decoder.ready;
      decoderRef.current = decoder;
      console.log("Ogg Opus decoder initialized");
    };

    initializeDecoder();

    return () => {
      if (decoderRef.current) {
        decoderRef.current.free();
      }
    };
  }, []);

  // Audio Playback: schedule PCM audio chunks for seamless playback
  const scheduleAudioPlayback = (newAudioData) => {
    const sampleRate = audioContext.sampleRate;
    const numberOfChannels = 1;
    const nowTime = audioContext.currentTime;

    // Create a new buffer and source node for the incoming audio data
    const newBuffer = audioContext.createBuffer(
      numberOfChannels,
      newAudioData.length,
      sampleRate
    );
    newBuffer.copyToChannel(newAudioData, 0);
    const sourceNode = audioContext.createBufferSource();
    sourceNode.buffer = newBuffer;
    sourceNode.connect(audioContext.destination);

    // Schedule the new audio to play immediately after any currently playing audio
    const startTime = Math.max(scheduledEndTimeRef.current, nowTime);
    sourceNode.start(startTime);

    // Update the scheduled end time so we know when to schedule the next piece of audio
    scheduledEndTimeRef.current = startTime + newBuffer.duration;

    if (sourceNodeRef.current && sourceNodeRef.current.buffer) {
      const currentEndTime =
        sourceNodeRef.current.startTime + sourceNodeRef.current.buffer.duration;
      if (currentEndTime <= nowTime) {
        sourceNodeRef.current.disconnect();
      }
    }
    sourceNodeRef.current = sourceNode;
  };

  // WebSocket: open websocket connection and start recording
  useEffect(() => {
    if (!wsEndpoint) {
      setConnectionStatus("error");
      setErrorMessage(
        "No websocket endpoint configured. Set window.LIVE_VOICE_WS_ENDPOINT in index.html or add ?ws=wss://YOUR-ENDPOINT/ws."
      );
      return;
    }

    let socket;
    try {
      console.log("Connecting to", wsEndpoint);
      socket = new WebSocket(wsEndpoint);
    } catch (error) {
      setConnectionStatus("error");
      setErrorMessage("Invalid websocket endpoint. Check the URL and try again.");
      return;
    }
    socketRef.current = socket;

    socket.onopen = () => {
      console.log("WebSocket connection opened");
      setConnectionStatus("connected");
      startRecording();
      setWarmupComplete(true);
    };

    socket.onmessage = async (event) => {
      // data is a blob, convert to array buffer
      const arrayBuffer = await event.data.arrayBuffer();
      const view = new Uint8Array(arrayBuffer);
      const tag = view[0];
      const payload = arrayBuffer.slice(1);
      if (tag === 1) {
        // audio data
        const { channelData, samplesDecoded } = await decoderRef.current.decode(
          new Uint8Array(payload)
        );
        if (samplesDecoded > 0) {
          scheduleAudioPlayback(channelData[0]);
        }
      }
      if (tag === 2) {
        // text data
        const decoder = new TextDecoder();
        const text = decoder.decode(payload);

        setPendingSentence((prevPending) => {
          const updatedPending = prevPending + text;
          if (
            updatedPending.endsWith(".") ||
            updatedPending.endsWith("!") ||
            updatedPending.endsWith("?")
          ) {
            setCompletedSentences((prevCompleted) => [
              ...prevCompleted,
              updatedPending,
            ]);
            return "";
          }
          return updatedPending;
        });
      }
    };

    socket.onerror = () => {
      setConnectionStatus("error");
      setErrorMessage("Connection error. Check your network or server status.");
    };

    socket.onclose = () => {
      console.log("WebSocket connection closed");
      setConnectionStatus("closed");
    };

    return () => {
      socket.close();
    };
  }, [wsEndpoint]);

  return (
    <div className="app">
      <header className="hero">
        <div className="brand">
          <div className="brand-mark">LV</div>
          <div>
            <h1>Live Voice Chat AI</h1>
            <p>
              Low-latency, full-duplex voice with instant transcription and streaming
              responses.
            </p>
            <div className="status-row">
              <span className={`status-pill ${warmupComplete ? "ready" : "warmup"}`}>
                {warmupComplete ? "Model Ready" : "Warming Up"}
              </span>
              <span className={`status-pill ${connectionStatus}`}>
                {connectionStatus === "connected" && "Live Connection"}
                {connectionStatus === "connecting" && "Connecting"}
                {connectionStatus === "closed" && "Disconnected"}
                {connectionStatus === "error" && "Connection Error"}
              </span>
            </div>
          </div>
        </div>
        <div className="hero-metrics">
          <div className="metric-card">
            <strong>24 kHz Audio</strong>
            Opus streaming for low latency voice.
          </div>
          <div className="metric-card">
            <strong>Bidirectional</strong>
            Speak and listen without interruptions.
          </div>
          <div className="metric-card">
            <strong>WebSocket</strong>
            {endpointLabel}
          </div>
        </div>
      </header>

      <main className="panel-grid">
        <section className="panel transcript">
          <div className="panel-header">
            <h2>Live Transcript</h2>
            <p>Auto-updates as you speak.</p>
          </div>
          <TextOutput
            warmupComplete={warmupComplete}
            completedSentences={completedSentences}
            pendingSentence={pendingSentence}
          />
        </section>

        <section className="panel control-panel">
          <div className="panel-header">
            <h2>Microphone</h2>
            <p>Tap to mute or unmute your stream.</p>
          </div>
          <AudioControl recorder={recorder} amplitude={amplitude} />
          {errorMessage ? <div className="error-box">{errorMessage}</div> : null}
        </section>
      </main>

      <footer className="footer">
        <span>
          Built with <a href="https://github.com/kyutai-labs/moshi">Moshi</a> and{" "}
          <a href="https://modal.com">Modal</a>
        </span>
        <span>
          Developed by{" "}
          <a href="https://github.com/anurag-m1" target="_blank" rel="noreferrer">
            Anurag Singh
          </a>{" "}
          ·{" "}
          <a href="https://instagram.com/ca_anuragsingh" target="_blank" rel="noreferrer">
            Instagram
          </a>
        </span>
        <img src="./modal-logo.svg" alt="Modal logo" />
      </footer>
    </div>
  );
};

const AudioControl = ({ recorder, amplitude }) => {
  const [muted, setMuted] = useState(true);

  const toggleMute = () => {
    if (!recorder) {
      return;
    }
    setMuted((prev) => !prev);
    recorder.setRecordingGain(muted ? 1 : 0);
  };

  // unmute automatically once the recorder is ready
  useEffect(() => {
    if (recorder) {
      setMuted(false);
      recorder.setRecordingGain(1);
    }
  }, [recorder]);

  const amplitudePercent = Math.min(amplitude / 255, 1);
  const coreScale = muted ? 0.75 : 0.85 + amplitudePercent * 0.35;
  const ringScale = muted ? 0.85 : 0.9 + amplitudePercent * 0.55;
  const ampWidth = Math.round(amplitudePercent * 100);

  return (
    <div className="mic-wrap">
      <button
        className={`mic-button ${muted ? "is-muted" : "is-live"}`}
        onClick={toggleMute}
        aria-pressed={muted}
        aria-label={muted ? "Unmute microphone" : "Mute microphone"}
      >
        <span className="mic-core" style={{ transform: `scale(${coreScale})` }} />
        <span className="mic-ring" style={{ transform: `scale(${ringScale})` }} />
        <span className="mic-label">{muted ? "Muted" : "Live"}</span>
      </button>
      <div className="mic-status">
        {recorder
          ? muted
            ? "Muted. Tap to resume streaming."
            : "Streaming live. Tap to mute."
          : "Waiting for microphone access..."}
      </div>
      <div className="mic-amp">
        <div className="mic-amp-bar" style={{ width: `${ampWidth}%` }}></div>
      </div>
    </div>
  );
};

const TextOutput = ({ warmupComplete, completedSentences, pendingSentence }) => {
  const containerRef = useRef(null);
  const allSentences = [...completedSentences, pendingSentence];
  if (pendingSentence.length === 0 && allSentences.length > 1) {
    allSentences.pop();
  }

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [completedSentences, pendingSentence]);

  if (!warmupComplete) {
    return (
      <div className="transcript-body transcript-placeholder">
        Warming up model...
      </div>
    );
  }

  if (allSentences.length === 0) {
    return (
      <div className="transcript-body transcript-placeholder">
        Start speaking to see the live transcript.
      </div>
    );
  }

  return (
    <div ref={containerRef} className="transcript-body">
      {allSentences
        .map((sentence, index) => (
          <p key={index} className="transcript-line">
            {sentence}
          </p>
        ))
        .reverse()}
    </div>
  );
};

const container = document.getElementById("react");
ReactDOM.createRoot(container).render(<App />);
