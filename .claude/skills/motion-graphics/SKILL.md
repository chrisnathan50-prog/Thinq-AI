---
name: motion-graphics
description: Make motion graphics and short videos as code (Canvas, SVG, Three.js) and render them to MP4 frame by frame. Use when the user asks for a video, animation, motion graphic, logo reveal, launch spot, explainer, lyric video or social clip.
---

# Motion graphics as code

You make videos by writing code that draws every frame, then rendering it frame by frame to MP4.
There is no video model. The quality comes from planning, timing and review.

## 1. Ask once, then work

If any of these are missing, ask for all of them in one message, then do not ask again:
- What should the viewer understand or feel by the end?
- Duration, aspect ratio (16:9, 9:16, 1:1, 4:5) and where it will play.
- Real facts, copy, brand colours, logo SVG, product UI or data. Never invent features, numbers or quotes.
- Audio: none, a track the user supplies (get the BPM), generated music, or voiceover.
- Style: one named style. If none is given, pick one and say why in one line.

## 2. Storyboard before code

Write a shot list and show it to the user before writing animation code:
- One row per shot: start time, end time, what is on screen, what the viewer must read, the transition out.
- List every "read" (a thing the viewer must notice) and give each its own slot. Fast actions, slow meanings.
- A hook inside the first second. Something happens in every shot. Hold the final frame 0.8 to 1.2 s.
- If there is music, put cuts and key hits on the beat grid. Not every beat gets a hit.

## 3. Build rules

- One `scene.html` that draws any moment on request. Expose `window.renderAt(t)` and also run a normal
  requestAnimationFrame preview loop that reads `performance.now()`.
- Every frame is a pure function of time. No counters that increment per frame, no unseeded `Math.random()`,
  no physics integrated step by step, no CSS transitions triggered by timers. Seed all randomness.
- `await document.fonts.ready` before the first frame. Load fonts locally or from a stable CDN.
- Write the style as numbers: hex colours, cubic-bezier curves, frame counts for staggers, grid margins.
- Keep text inside a 5% safe margin (middle 80% for vertical social video).
- Default avoid list unless the style asks for it: particle bursts, lens flares, neon glow, RGB split, glitch,
  bouncy easing on everything, decorative gradients, text that repeats what the picture shows.

## 4. Review before the full render

- Render a contact sheet: one frame per second (or per beat) tiled into one PNG. Open it and look.
- Check for: overlapping or clipped text, text on screen too short to read (about 0.3 s per word, minimum 1 s),
  dead time, fallback fonts, elements too small to see at phone size, black frames.
- Fix what you find, then render a half-resolution draft, then the final.

## 5. Render

Use a virtual clock: replace `performance.now`, `Date.now` and `requestAnimationFrame`, advance time by exactly
1/fps per frame, screenshot each frame, pipe the PNGs into ffmpeg. Reference script:
https://awesomeclaude.ai/claude-video-render.mjs

```bash
node claude-video-render.mjs scene.html out.mp4 15 60 1920 1080
ffmpeg -i out.mp4 -i track.mp3 -c:v copy -c:a aac -b:a 192k -shortest final.mp4
```

Never record audio from the browser. Mux the track with ffmpeg so sync is exact.

## 6. Report

Deliver the MP4 path, the storyboard as built, the style rules you followed, and the two weakest moments
with how you would fix them in another round.

---
Made by awesomeclaude.ai. Styles with copy-paste rules: https://awesomeclaude.ai/claude-motion-graphics
