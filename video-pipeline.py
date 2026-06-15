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


# ============= VIDEO CREATION =============
def create_signal_video(signal_data, output_path, voice="en_male"):
    """Create a 30-60s vertical video (9:16) from a crypto signal"""

    # Generate script from signal
    direction = signal_data.get("direction", "LONG")
    pair = signal_data.get("pair", "BTC/USDT")
    entry = signal_data.get("entry", "?")
    targets = signal_data.get("targets", [])
    stop_loss = signal_data.get("stopLoss", "?")
    source = signal_data.get("source", "aggregated")

    arrow = "UP" if direction == "LONG" else "DOWN"
    emoji_dir = "bullish" if direction == "LONG" else "bearish"

    script = f"""
    Breaking crypto signal alert!
    {pair} is looking {emoji_dir}.
    Direction: {direction}.
    Entry price: {entry} dollars.
    {"Target: " + ", then ".join(targets[:3]) + " dollars." if targets else ""}
    {"Stop loss at " + str(stop_loss) + " dollars." if stop_loss and stop_loss != "?" else ""}
    This signal was aggregated from 15 top analyst channels.
    Want more signals like this? Follow the link in bio.
    Crypto Signal Hub. Your edge in the market.
    """

    # Clean up script
    script = re.sub(r'\s+', ' ', script).strip()

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        audio_path = tmp / "voice.mp3"
        video_path = tmp / "video.mp4"

        # 1. Generate TTS audio
        asyncio.run(generate_tts(script, audio_path, voice))

        # Get audio duration
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(audio_path)],
            capture_output=True, text=True
        )
        duration = float(result.stdout.strip()) if result.stdout.strip() else 30

        # 2. Create video with FFmpeg
        # Dark gradient background + animated text overlay
        dir_color = "0x00FF88" if direction == "LONG" else "0xFF4444"
        dir_symbol = "▲" if direction == "LONG" else "▼"

        # Build drawtext filters for signal info
        texts = [
            f"drawtext=text='{dir_symbol} {direction}':fontsize=72:fontcolor={dir_color}:x=(w-text_w)/2:y=180:fontfile=C\\\\:/Windows/Fonts/arialbd.ttf",
            f"drawtext=text='{pair}':fontsize=64:fontcolor=white:x=(w-text_w)/2:y=280:fontfile=C\\\\:/Windows/Fonts/arialbd.ttf",
            f"drawtext=text='Entry\\: ${entry}':fontsize=40:fontcolor=0xCCCCCC:x=(w-text_w)/2:y=420:fontfile=C\\\\:/Windows/Fonts/arial.ttf",
        ]

        y_pos = 500
        for i, tp in enumerate(targets[:3]):
            texts.append(f"drawtext=text='TP{i+1}\\: ${tp}':fontsize=36:fontcolor=0x00FF88:x=(w-text_w)/2:y={y_pos}:fontfile=C\\\\:/Windows/Fonts/arial.ttf")
            y_pos += 60

        if stop_loss != "?":
            texts.append(f"drawtext=text='SL\\: ${stop_loss}':fontsize=36:fontcolor=0xFF4444:x=(w-text_w)/2:y={y_pos}:fontfile=C\\\\:/Windows/Fonts/arial.ttf")
            y_pos += 80

        texts.append(f"drawtext=text='t.me/cshub_signals_bot':fontsize=28:fontcolor=0x00BBFF:x=(w-text_w)/2:y={y_pos+40}:fontfile=C\\\\:/Windows/Fonts/arial.ttf")
        texts.append(f"drawtext=text='Crypto Signal Hub':fontsize=24:fontcolor=0x888888:x=(w-text_w)/2:y={y_pos+80}:fontfile=C\\\\:/Windows/Fonts/arial.ttf")

        filter_text = ",".join(texts)

        cmd = [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", f"color=c=0x0a0a1a:s=1080x1920:d={duration}",
            "-i", str(audio_path),
            "-vf", filter_text,
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k",
            "-pix_fmt", "yuv420p",
            "-shortest",
            str(video_path)
        ]

        subprocess.run(cmd, capture_output=True, timeout=120)

        if video_path.exists():
            # Copy to output
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
