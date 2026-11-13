// ADR 0171 (K0): the recorder's hook in `CoreLink.handleMessage` runs after the STATUS decode and before the RECYCLE,
// on the raw block (its STATUS envelope intact) with the envelope's total bytes; with no tap nothing changes.
import { describe, expect, it } from "vitest";
import { CoreLink, type LinkPort } from "./context";
import { Kind, MAGIC, type StatusBlock } from "../wire.generated";

function statusBuffer(bodyBytes: number): ArrayBuffer {
  const buffer = new ArrayBuffer(16 + bodyBytes + 64);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(6, Kind.STATUS, true);
  view.setUint32(12, bodyBytes, true);
  return buffer;
}

function rig() {
  const order: string[] = [];
  const port: LinkPort = {
    postMessage: (message) => {
      if (message instanceof ArrayBuffer) order.push(`post:${new DataView(message).getUint16(6, true)}`);
    },
    onmessage: null,
  };
  const link = new CoreLink(port);
  link.statusDecoder = () => {
    order.push("decode");
    return { flags: 0, abiVersion: 0 } as unknown as StatusBlock;
  };
  return { link, order };
}

describe("CoreLink.recorderTap (K0)", () => {
  it("is called between the decode and the RECYCLE with the raw STATUS and its bytes", () => {
    const { link, order } = rig();
    const seen: { kind: number; bytes: number }[] = [];
    link.recorderTap = (data, byteLength) => {
      order.push("tap");
      seen.push({ kind: new DataView(data).getUint16(6, true), bytes: byteLength });
    };
    link.handleMessage(statusBuffer(200));
    expect(order).toEqual(["decode", "tap", `post:${Kind.RECYCLE}`]);
    expect(seen).toEqual([{ kind: Kind.STATUS, bytes: 216 }]);
  });

  it("is null by default: the block is decoded and recycled as before", () => {
    const { link, order } = rig();
    expect(link.recorderTap).toBeNull();
    link.handleMessage(statusBuffer(100));
    expect(order).toEqual(["decode", `post:${Kind.RECYCLE}`]);
  });
});
