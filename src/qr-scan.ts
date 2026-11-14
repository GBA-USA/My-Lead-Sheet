import { codeInText } from "./code-link";

const FRAME_MS = 150;
const MAX_SIDE = 640;

/**
 * Shows the back camera in `video` and reads its frames with the bundled decoder until one holds a code link,
 * then returns the code's payload. iOS Safari has no built-in QR decoder, so jsQR is loaded here on first use.
 */
export async function scanCamera(video: HTMLVideoElement, signal: AbortSignal): Promise<string> {
  const [{ default: jsQR }, stream] = await Promise.all([import("jsqr"), navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })]);
  try {
    video.srcObject = stream;
    await video.play();
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    while (!signal.aborted) {
      await new Promise((done) => setTimeout(done, FRAME_MS));
      const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight, 1));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      if (!canvas.width || !canvas.height) continue;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = context.getImageData(0, 0, canvas.width, canvas.height);
      const found = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" });
      const payload = found && codeInText(found.data);
      if (payload) return payload;
    }
    throw new DOMException("The scan was closed", "AbortError");
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  }
}
