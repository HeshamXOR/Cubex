let field: HTMLTextAreaElement | null = null

/** The composer tells this where its field is, so other code can put the caret there. */
export function registerComposer(element: HTMLTextAreaElement | null): void {
  field = element
}

/** Focus the composer with the caret after what it holds, once the pending render has put the text there. */
export function focusComposer(): void {
  requestAnimationFrame(() => {
    if (!field) return
    field.focus()
    const end = field.value.length
    field.setSelectionRange(end, end)
  })
}
