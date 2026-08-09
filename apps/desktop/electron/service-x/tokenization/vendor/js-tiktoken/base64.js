// Node-only replacement for js-tiktoken's tiny base64-js dependency. Service X
// runs in Electron main/worker processes, where Buffer is always available.
export default {
  toByteArray(value) {
    return new Uint8Array(Buffer.from(value, 'base64'))
  }
}
