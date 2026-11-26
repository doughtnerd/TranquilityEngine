/** Props a test or script can change after mounting: a deep `$state` proxy. */
export function reactive<T extends object>(initial: T): T {
  const s = $state(initial);
  return s;
}
