"""
Auto Video Pipeline — generates crypto signal videos and uploads to TikTok/YouTube
Uses: edge-tts (free Microsoft TTS), FFmpeg (video creation), Playwright (upload)
"""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import re
from pathlib import Path

ROOT = Path(__file__).parent
DATA = ROOT / "data"
VIDEOS = DATA / "videos"
VIDEOS.mkdir(parents=True, exist_ok=True)

# Edge TTS voices
VOICES = {
    "en_male": "en-US-GuyNeural",
    "en_female": "en-US-JennyNeural",
    "pl_male": "pl-PL-MarekNeural",
    "pl_female": "pl-PL-ZofiaNeural",
}

# ============= TTS =============
async def generate_tts(text, output_path, voice="en_male"):
    """Generate speech from text using Edge TTS (free, no API key needed)"""
    import edge_tts
    v = VOICES.get(voice, voice)
    communicate = edge_tts.Communicate(text, v)
    await communicate.save(str(output_path))
    return output_path


# ============= VIDEO CREATION (HTML template → screenshot → video) =============
def create_signal_video(signal_data, output_path, voice="en_male"):
    """Create pro 9:16 video from HTML template + TTS audio"""
    direction = signal_data.get("direction") or "LONG"
    pair = signal_data.get("pair") or "BTC/USDT"
    entry = signal_data.get("entry") or "?"
    targets = signal_data.get("targets") or []
    stop_loss = signal_data.get("stopLoss") or ""
    leverage = signal_data.get("leverage") or ""
    source = signal_data.get("source") or "aggregated"

    emoji_dir = "bullish" if direction == "LONG" else "bearish"
    script = (
        f"Breaking crypto signal alert! "
        f"{pair} is looking {emoji_dir}. Direction: {direction}. "
        f"Entry price: {entry} dollars. "
        + (f"Target: {', then '.join(str(t) for t in targets[:3])} dollars. " if targets else "")
        + (f"Stop loss at {stop_loss} dollars. " if stop_loss else "")
        + "This signal was aggregated from 15 top analyst channels. "
        + "Want more signals like this? Follow at tee dot me slash c s hub signals bot. "
        + "Crypto Signal Hub. Your edge in the market."
    )

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        audio_path = tmp / "voice.mp3"
        frame_path = tmp / "frame.png"
        video_path = tmp / "video.mp4"

        # 1. Generate TTS
        asyncio.run(generate_tts(script, audio_path, voice))

        # Get duration
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(audio_path)],
            capture_output=True, text=True
        )
        duration = float(result.stdout.strip()) if result.stdout.strip() else 30

        # 2. Render HTML template as screenshot using Playwright
        template_path = ROOT / "data" / "video-template.html"
        params = f"d={direction}&p={pair}&e={entry}"
        for i, t in enumerate(targets[:3]):
            params += f"&t{i+1}={t}"
        if stop_loss: params += f"&sl={stop_loss}"
        if leverage: params += f"&lev={leverage}"
        params += f"&src={source}"

        # Use Playwright sync API to screenshot
        try:
            from playwright.sync_api import sync_playwright
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                page = browser.new_page(viewport={"width": 1080, "height": 1920})
                file_url = template_path.as_uri() + "?" + params
                page.goto(file_url)
                page.wait_for_timeout(2500)  # Wait for CSS animations
                page.screenshot(path=str(frame_path))
                browser.close()
        except Exception as e:
            print(f"[video] Playwright screenshot failed: {e}, using FFmpeg fallback")
            # Fallback: simple dark bg with text
            dir_color = "0x00FF88" if direction == "LONG" else "0xFF4444"
            cmd = ["ffmpeg", "-y", "-f", "lavfi", "-i", f"color=c=0x0a0a1a:s=1080x1920:d=1",
                   "-vf", f"drawtext=text='{direction} {pair}':fontsize=72:fontcolor={dir_color}:x=(w-text_w)/2:y=(h-text_h)/2",
                   "-frames:v", "1", str(frame_path)]
            subprocess.run(cmd, capture_output=True, timeout=10)

        if not frame_path.exists():
            print("[video] Frame generation failed entirely")
            return None

        # 3. Combine: static frame (looped) + audio → video
        # Add subtle zoom animation for more dynamic feel
        cmd = [
            "ffmpeg", "-y",
            "-loop", "1", "-i", str(frame_path),
            "-i", str(audio_path),
            "-vf", (
                f"scale=1120:1990,crop=1080:1920:(iw-1080)/2*(1-t/{duration}):(ih-1920)/2,"
                "format=yuv420p"
            ),
            "-c:v", "libx264", "-preset", "fast", "-crf", "20",
            "-c:a", "aac", "-b:a", "192k",
            "-t", str(min(duration + 1, 60)),
            "-shortest",
            "-movflags", "+faststart",
            str(video_path)
        ]
        subprocess.run(cmd, capture_output=True, timeout=120)

        if video_path.exists():
            import shutil
            shutil.copy2(str(video_path), str(output_path))
            return str(output_path)

    return None


# ============= SIGNAL LOADER =============
def load_latest_signal():
    """Load the best signal from scraped data"""
    scraped_path = DATA / "scraped-signals.json"
    if not scraped_path.exists():
        return None

    data = json.loads(scraped_path.read_text(encoding="utf-8"))
    signals = data.get("signals", [])

    # Find best signal (has pair + direction + entry)
    good = [s for s in signals if s.get("pair") and s.get("direction") and s.get("entry")]
    if good:
        return good[-1]  # Most recent good signal

    # Fallback: any signal with pair
    with_pair = [s for s in signals if s.get("pair")]
    return with_pair[-1] if with_pair else (signals[-1] if signals else None)


# ============= TIKTOK UPLOAD =============
async def upload_to_tiktok(video_path, description):
    """Upload video to TikTok using browser automation"""
    try:
        from playwright.async_api import async_playwright
        async with async_playwright() as p:
            # Use saved TikTok session from Chrome
            context = await p.chromium.launch_persistent_context(
                str(DATA / "tiktok-session"),
                headless=False,
                args=["--disable-blink-features=AutomationControlled"],
                viewport={"width": 1280, "height": 720}
            )
            page = context.pages[0] if context.pages else await context.new_page()

            await page.goto("https://www.tiktok.com/upload")
            await page.wait_for_timeout(3000)

            # Check if logged in
            if "login" in page.url.lower():
                print("[tiktok] Not logged in. First time — login manually in the browser window.")
                print("[tiktok] After logging in, close the browser. Session will be saved.")
                await page.wait_for_timeout(120000)  # Wait 2 min for manual login
                await context.close()
                return False

            # Upload file
            file_input = await page.query_selector('input[type="file"]')
            if file_input:
                await file_input.set_input_files(video_path)
                await page.wait_for_timeout(5000)

            # Set description
            caption = await page.query_selector('[data-text="true"], .public-DraftStyleDefault-block')
            if caption:
                await caption.click()
                await page.keyboard.type(description)
                await page.wait_for_timeout(2000)

            # Click Post
            post_btn = await page.query_selector('button:has-text("Post"), button:has-text("Publish")')
            if post_btn:
                await post_btn.click()
                await page.wait_for_timeout(10000)
                print("[tiktok] Video posted!")

            await context.close()
            return True
    except Exception as e:
        print(f"[tiktok] Upload error: {e}")
        return False


# ============= MAIN =============
def main():
    print("[video-pipeline] Loading latest signal...")
    signal = load_latest_signal()

    if not signal:
        print("[video-pipeline] No signals found. Run multi-bot first.")
        return

    print(f"[video-pipeline] Signal: {signal.get('direction', '?')} {signal.get('pair', '?')} from {signal.get('source', '?')}")

    # Generate video
    timestamp = int(time.time())
    pair_slug = (signal.get("pair") or "crypto").replace("/", "-").lower()
    output_path = VIDEOS / f"signal-{pair_slug}-{timestamp}.mp4"

    print(f"[video-pipeline] Generating video...")
    result = create_signal_video(signal, output_path)

    if result:
        size_mb = os.path.getsize(result) / (1024 * 1024)
        print(f"[video-pipeline] Video created: {result} ({size_mb:.1f} MB)")

        # Send notification to admin bot
        try:
            cfg = json.loads((ROOT / "config.json").read_text())
            import urllib.request
            msg = f"🎬 Video generated!\n\n{signal.get('direction', '?')} {signal.get('pair', '?')}\nFile: {output_path.name}\nSize: {size_mb:.1f} MB\n\nUpload to TikTok: python video-pipeline.py --upload"
            data = json.dumps({"chat_id": cfg["telegramChatId"], "text": msg}).encode()
            req = urllib.request.Request(
                f"https://api.telegram.org/bot{cfg['telegramToken']}/sendMessage",
                data=data, headers={"Content-Type": "application/json"}
            )
            urllib.request.urlopen(req)
        except:
            pass

        # Upload if --upload flag
        if "--upload" in sys.argv:
            desc = f"{'🟢' if signal.get('direction') == 'LONG' else '🔴'} {signal.get('direction', '')} {signal.get('pair', '')} signal\n\n📊 Follow for more: t.me/cshub_signals_bot\n\n#crypto #signals #trading #bitcoin"
            asyncio.run(upload_to_tiktok(str(output_path), desc))
    else:
        print("[video-pipeline] Video generation failed!")


if __name__ == "__main__":
    main()
