import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import "./qrScanner.css";

type Props = {
  onScan: (text: string) => void;
  onCancel: () => void;
};

// PLAN.md "QR pairing" — reusable camera scanner, currently only used to
// pair with iptv-recorder's own client-creation QR code (see
// RecorderConnection.tsx), but decode-only and payload-agnostic: onScan
// gets the raw decoded text, the caller decides what it means.
//
// requestAnimationFrame-driven scan loop over jsQR (a plain decode-from-
// pixels library, not a getUserMedia wrapper) rather than the native
// BarcodeDetector API — BarcodeDetector isn't implemented in Safari at
// all, including iOS, which is the actual device this was built for
// (PLAN.md "Guide UI polish, round 6" / the Caddy HTTPS work — camera
// access needs a secure context, which is why that HTTPS route had to
// exist before this could work at all).
export function QrScanner({ onScan, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const [error, setError] = useState<string>();
  // Captured via a ref, not an effect dependency — an inline arrow function
  // prop would otherwise be a new reference every render, which would
  // restart the camera request in a loop instead of running once.
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    let cancelled = false;

    function stopStream() {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    function scanLoop() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
        rafRef.current = requestAnimationFrame(scanLoop);
        return;
      }
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      if (code?.data) {
        // Stop immediately on a hit, not just here — belt and suspenders
        // with the cleanup below, since a caller that doesn't unmount this
        // component right away on onScan would otherwise leave the camera
        // running for no reason.
        stopStream();
        onScanRef.current(code.data);
        return;
      }
      rafRef.current = requestAnimationFrame(scanLoop);
    }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        video.play().catch(() => {});
        rafRef.current = requestAnimationFrame(scanLoop);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      stopStream();
    };
  }, []);

  return (
    <div className="qr-scanner">
      {error ? (
        <p className="error">Couldn't access the camera: {error}</p>
      ) : (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- silent camera preview, not a media file
        <video ref={videoRef} playsInline muted className="qr-scanner-video" />
      )}
      <canvas ref={canvasRef} className="qr-scanner-canvas" />
      <button type="button" className="button-link" onClick={onCancel}>
        Cancel scanning
      </button>
    </div>
  );
}
