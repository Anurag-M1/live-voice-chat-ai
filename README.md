# Live Voice Chat AI

A real-time voice chat web app with streaming audio, live transcription, and low-latency responses.
live url: https://live-voice-chat-ai.onrender.com

## Highlights
- Full-duplex audio streaming (talk and listen without turn-taking)
- Live transcript feed
- Modern single-page UI (no frontend build step)

## Stack
- Frontend: React (CDN), vanilla CSS, Opus recorder/decoder
- Backend: FastAPI for static assets + websocket server for streaming
- Model: Kyutai Labs Moshi (speech-to-speech)

## Project Structure
- `src/frontend/` UI (served as static files)
- `src/app.py` FastAPI server for static assets
- `src/moshi.py` websocket server for model streaming

## Quick Start (Modal)
1. Install Modal
   ```shell
   pip install modal
   ```
2. Authenticate
   ```shell
   modal setup
   ```
3. Run the app
   ```shell
   modal serve src.app
   ```

## Render (Frontend Only)
You can host the UI on Render and keep the websocket backend on Modal.

1. Deploy the backend on Modal
   ```shell
   modal deploy src.app
   ```
2. Create a Render Static Site connected to this repo
3. Set the Render publish directory to `src/frontend`
4. Set the websocket endpoint in `src/frontend/index.html` via `window.LIVE_VOICE_WS_ENDPOINT`, or pass it at runtime like `https://your-render-site?ws=wss://YOUR-MODAL-ENDPOINT/ws`.

## Notes
- Microphone access is required in the browser.
- If you update frontend assets and don’t see changes, clear your browser cache.

## Credits
Developed by [Anurag Singh](https://github.com/anurag-m1)
