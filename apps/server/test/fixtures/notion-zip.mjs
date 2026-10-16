// Independent, in-memory STORE ZIP writer. This fixture contains invented data only.
export function archive(files) {
  const chunks = [], records = [];
  let offset = 0;
  for (const [name, text] of files) {
    const filename = Buffer.from(name), content = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30 + filename.length);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(filename.length, 26); filename.copy(local, 30);
    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42); filename.copy(central, 46);
    chunks.push(local, content); records.push(central); offset += local.length + content.length;
  }
  const size = records.reduce((sum, item) => sum + item.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, ...records, end]));
}
