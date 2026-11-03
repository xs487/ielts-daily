# IELTS DAILY public site

The public build excludes the personal vocabulary dictionary supplied during development. Each visitor imports their own words. OCR runs locally in the browser; generating a practice set and grading writing sends the submitted text to OpenAI through the server function. The website does not store vocabulary on its server.

Deploy this directory as the project root on Vercel. Add `OPENAI_API_KEY`, `UPSTASH_REDIS_REST_URL`, and `UPSTASH_REDIS_REST_TOKEN` as server-side environment variables. Never put their values in this repository or browser code. `OPENAI_MODEL` and `OPENAI_TTS_MODEL` are optional. The API limits each IP to one full set per day, four audio requests per day, and eight writing assessments per hour. Also set a restrictive usage budget in the OpenAI project. Rotate any key previously pasted into chat before deployment.

Vocabulary and writing submitted for generation/feedback are sent to OpenAI. Upstash stores only hashed IPs and request counters for rate limits. Vocabulary, answers, drafts, and feedback are saved in each visitor's browser. Microphone recording requires HTTPS. Third-party component notices are in `vendor/NOTICE.md`.
