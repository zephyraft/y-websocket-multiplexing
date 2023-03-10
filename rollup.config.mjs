import typescript from '@rollup/plugin-typescript'

export default {
  input: './src/y-websocket.ts',
  external: id => /^(lib0|yjs|y-protocols)/.test(id),
  output: [{
    name: 'y-websocket',
    file: 'dist/y-websocket.cjs',
    format: 'cjs',
    sourcemap: true,
    paths: path => {
      if (/^lib0\//.test(path)) {
        return `lib0/dist${path.slice(4)}.cjs`
      } else if (/^y-protocols\//.test(path)) {
        return `y-protocols/dist${path.slice(11)}.cjs`
      }
      return path
    }
  }, {
    name: 'y-websocket',
    file: 'dist/y-websocket.mjs',
    format: 'es',
    sourcemap: true,
    // paths: path => {
    //   if (/^lib0\//.test(path)) {
    //     return `lib0/dist${path.slice(4)}.cjs`
    //   } else if (/^y-protocols\//.test(path)) {
    //     return `y-protocols/dist${path.slice(11)}.cjs`
    //   }
    //   return path
    // }
  }],
  plugins: [typescript()]
}
