# Gemini web video worker

This Windows worker claims durable video jobs from Agentic on Render, asks local Qwen to create one production prompt, controls a dedicated logged-in Gemini Chrome profile, downloads the original MP4, validates it without FFmpeg, uploads it unchanged to object storage, and returns its checksum to Render.

## First run

1. Copy `.env.example` to `.env` and set `AGENTIC_API_URL` and `GEMINI_VIDEO_WORKER_TOKEN`.
2. Double-click `start-video-worker.bat`.
3. Restore the minimized dedicated Chrome window and sign in to the Google account that has Gemini video access.
4. Keep the BAT window running. Chrome can remain minimized after login.

The worker does not bypass CAPTCHA, account confirmation, reauthentication, quotas, or any other Google control. If the Gemini UI changes, update the optional selectors in `.env`.
