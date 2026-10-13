/** CRC-16/MCRF4XX ("X.25" in MAVLink terms), initial value 0xFFFF. */
export function crcAccumulate(byte: number, crc: number): number {
  let tmp = (byte ^ (crc & 0xff)) & 0xff;
  tmp = (tmp ^ (tmp << 4)) & 0xff;
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
}

export function crcBytes(bytes: Uint8Array, start: number, end: number, crc = 0xffff): number {
  for (let i = start; i < end; i++) crc = crcAccumulate(bytes[i]!, crc);
  return crc;
}

export function crcString(s: string, crc = 0xffff): number {
  for (let i = 0; i < s.length; i++) crc = crcAccumulate(s.charCodeAt(i) & 0xff, crc);
  return crc;
}
