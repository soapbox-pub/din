// Just enough Protocol Buffers for Quick Share (quickshare.mts): read a
// message into its fields by number, and write one field by field. There's no
// schema here; the caller knows what each field number means, as the .proto
// files in Google's Nearby code say.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

/** A message's fields by number, each with every value it had (varints as bigints, the rest as bytes). */
export type Fields = Map<number, (bigint | Buffer)[]>;

const MAX_VARINT_BYTES = 10;

function readVarint(buffer: Buffer, offset: number): [bigint, number] {
  let value = 0n;
  let shift = 0n;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    if (offset >= buffer.length) throw new Error('protobuf: truncated varint');
    const byte = buffer[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [value, offset];
    shift += 7n;
  }
  throw new Error('protobuf: varint too long');
}

export function decode(buffer: Buffer): Fields {
  const fields: Fields = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const [key, next] = readVarint(buffer, offset);
    offset = next;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    let value: bigint | Buffer;
    if (wire === 0) {
      [value, offset] = readVarint(buffer, offset);
    } else if (wire === 2) {
      const [length, start] = readVarint(buffer, offset);
      const end = start + Number(length);
      if (length > BigInt(buffer.length) || end > buffer.length) throw new Error('protobuf: truncated field');
      value = buffer.subarray(start, end);
      offset = end;
    } else if (wire === 1 || wire === 5) {
      const end = offset + (wire === 1 ? 8 : 4);
      if (end > buffer.length) throw new Error('protobuf: truncated field');
      value = buffer.subarray(offset, end);
      offset = end;
    } else {
      throw new Error(`protobuf: wire type ${wire}`);
    }
    if (field === 0) throw new Error('protobuf: field 0');
    const list = fields.get(field);
    if (list) list.push(value);
    else fields.set(field, [value]);
  }
  return fields;
}

/** A field's last varint as a signed 64-bit integer (how int32, int64 and enums are read). */
export function big(fields: Fields, field: number): bigint | undefined {
  const values = fields.get(field);
  const value = values?.[values.length - 1];
  return typeof value === 'bigint' ? BigInt.asIntN(64, value) : undefined;
}

/** A field's last varint as a number (int32s, enums, sizes). */
export function int(fields: Fields, field: number): number | undefined {
  const value = big(fields, field);
  return value === undefined ? undefined : Number(value);
}

export function bytes(fields: Fields, field: number): Buffer | undefined {
  const values = fields.get(field);
  const value = values?.[values.length - 1];
  return Buffer.isBuffer(value) ? value : undefined;
}

export function str(fields: Fields, field: number): string | undefined {
  return bytes(fields, field)?.toString('utf8');
}

export function message(fields: Fields, field: number): Fields | undefined {
  const value = bytes(fields, field);
  return value ? decode(value) : undefined;
}

/** Every value of a repeated message field. */
export function messages(fields: Fields, field: number): Fields[] {
  return (fields.get(field) ?? []).filter((v): v is Buffer => Buffer.isBuffer(v)).map(decode);
}

function varint(value: bigint): Buffer {
  let v = BigInt.asUintN(64, value);
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return Buffer.from(out);
}

/** Builds a message a field at a time; unset (undefined) values are left out. */
export class Writer {
  private parts: Buffer[] = [];

  /** An int32, int64, bool or enum. */
  int(field: number, value: number | bigint | boolean | undefined): this {
    if (value === undefined) return this;
    const v = typeof value === 'boolean' ? (value ? 1n : 0n) : BigInt(value);
    this.parts.push(varint(BigInt(field << 3)), varint(v));
    return this;
  }

  /** Bytes, a string, or a nested message. */
  bytes(field: number, value: Uint8Array | string | Writer | undefined): this {
    if (value === undefined) return this;
    const data = value instanceof Writer ? value.finish() : typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
    this.parts.push(varint(BigInt((field << 3) | 2)), varint(BigInt(data.length)), data);
    return this;
  }

  finish(): Buffer {
    return Buffer.concat(this.parts);
  }
}
