declare module '*?raw' {
  const content: string
  export default content
}

declare module '*?worker&url' {
  const url: string
  export default url
}

declare module '*.css'
