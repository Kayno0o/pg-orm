export function capitalize<S extends string>(text: S): Capitalize<S> {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}` as Capitalize<S>
}
