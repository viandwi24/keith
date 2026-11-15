/** The generation now current: the last of `chat.generations` (oldest first), 0 when the list is empty. */
export function currentGenerationOf(list: readonly { generation: number }[]): number {
  return list.at(-1)?.generation ?? 0
}
