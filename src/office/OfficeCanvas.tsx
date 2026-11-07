import { useEffect, useRef } from "react";
import { OfficeScene } from "./OfficeScene";

/** Mounts the PixiJS office once. The scene syncs itself from the stores. */
export function OfficeCanvas() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const scene = new OfficeScene();
    void scene.init(el);
    return () => scene.destroy();
  }, []);

  return <div ref={host} className="fixed inset-0" aria-label="Pixel-art view of the BasePod HQ office" role="img" />;
}
