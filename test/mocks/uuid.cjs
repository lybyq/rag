/** Jest 29 不能加载 uuid 13 的 ESM；该替身只实现 Thrift 导入时需要的同步编解码。 */
function parse(value) {
  const hex = value.replaceAll('-', '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new TypeError('Invalid UUID');
  return Uint8Array.from(hex.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)));
}

function stringify(bytes) {
  if (!bytes || bytes.length !== 16) throw new TypeError('Invalid UUID bytes');
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

module.exports = { parse, stringify };
