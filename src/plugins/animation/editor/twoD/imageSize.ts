// The image a 2D tool draws slices from: its size once it has loaded (ADR 0373 "2D tools"; T56).
import { useEffect, useState } from "preact/hooks";

/** The natural size of the image at `url` once it has loaded, else null. */
export function useImageSize(url: string): readonly [number, number] | null {
  const [size, setSize] = useState<readonly [number, number] | null>(null);
  useEffect(() => {
    setSize(null);
    const img = new Image();
    img.onload = () => setSize([img.naturalWidth, img.naturalHeight]);
    img.src = url;
    return () => {
      img.onload = null;
    };
  }, [url]);
  return size;
}
