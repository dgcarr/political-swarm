/** Wait for every in-flight call before propagating a failure, so no late call mutates a closed run. */
export async function awaitAllOrThrow<T>(calls: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(calls);
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
}
