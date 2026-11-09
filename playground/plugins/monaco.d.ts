// Пакет monaco-editor отдаёт типы только корнем; вид берёт из него собранный вход с редактором и всеми языками.
declare module 'monaco-editor/editor/editor.main.js' {
  export * from 'monaco-editor';
}
