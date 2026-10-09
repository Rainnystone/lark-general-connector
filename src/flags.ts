/** Kill switch: only empty, "0", and "false" leave the connector enabled. */
export function isDisabled(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}
