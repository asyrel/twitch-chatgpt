// Minimal streaming ZIP writer (store, no compression - images are already compressed).
import { once } from 'node:events';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export class ZipWriter {
  constructor(out) {
    this.out = out;
    this.offset = 0;
    this.entries = [];
  }

  async #write(buf) {
    this.offset += buf.length;
    if (!this.out.write(buf)) await once(this.out, 'drain');
  }

  async addFile(name, data) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const { time, date } = dosDateTime();
    if (this.offset + data.length > 0xffffffff) throw new Error('ZIP larger than 4 GB is not supported');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);       // version needed
    h.writeUInt16LE(0x0800, 6);   // UTF-8 names
    h.writeUInt16LE(0, 8);        // stored
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);
    this.entries.push({ nameBuf, crc, size: data.length, time, date, offset: this.offset });
    await this.#write(h);
    await this.#write(nameBuf);
    await this.#write(data);
  }

  async finish() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(0, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.size, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.nameBuf.length, 28);
      c.writeUInt32LE(e.offset, 42);
      await this.#write(c);
      await this.#write(e.nameBuf);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - cdStart, 12);
    end.writeUInt32LE(cdStart, 16);
    await this.#write(end);
  }
}
