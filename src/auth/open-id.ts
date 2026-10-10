const OPEN_ID = /^ou_[0-9A-Za-z]+$/;

/** An owner value that is not an open_id means nobody is configured. */
export function configuredOwner(value: string): string | null {
  const owner = value.trim();
  return OPEN_ID.test(owner) ? owner : null;
}
