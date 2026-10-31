# Gemini web video worker

This Windows worker claims durable video jobs from Agentic on Render, asks local Qwen to create one production prompt, controls a dedicated logged-in Gemini Chrome profile, downloads the original MP4, validates it without FFmpeg, uploads it unchanged to object storage, and returns its checksum to Render.

## First run

1. Copy `.env.example` to `.env` and set `AGENTIC_API_URL` and `GEMINI_VIDEO_WORKER_TOKEN`.
2. Double-click `start-video-worker.bat`.
3. Restore the minimized dedicated Chrome window and sign in to the Google account that has Gemini video access.
4. Keep the BAT window running. Chrome can remain minimized after login.

The worker does not bypass CAPTCHA, account confirmation, reauthentication, quotas, or any other Google control. If the Gemini UI changes, update the optional selectors in `.env`.

## Logs and text-only Gemini responses

The BAT window now prints timestamped JSON events for job claiming, Qwen planning, Chrome connection, video-mode selection, Gemini waiting time, download, validation, upload, completion, heartbeats, API response codes and failures. The same output is retained in `logs/worker.log` by default; change `GEMINI_WORKER_LOG_FILE` to use another location.

Selecting **Create video** is mandatory. If the control cannot be found, the worker stops that job before submitting the prompt as ordinary chat. If Gemini returns an explanation, production breakdown, VideoFX instructions or another stable text response instead of a downloadable video, the worker reports a non-retryable failure after `GEMINI_TEXT_RESPONSE_GRACE_SECONDS` rather than waiting for the full generation timeout or repeatedly consuming attempts.
