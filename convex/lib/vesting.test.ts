import { describe, expect, test } from "vitest"
import { compareNames, normalizeLegalName, parseVesting } from "./vesting"

describe("normalizeLegalName", () => {
  test("Rene S Kotter, AIF → person with capacity AIF", () => {
    const n = normalizeLegalName("Rene S Kotter, AIF")
    expect(n.isPerson).toBe(true)
    expect(n.capacity).toBe("AIF")
    expect(n.canonical).toBe("RENE S KOTTER")
    expect(n.surname).toBe("KOTTER")
    expect(n.given).toBe("RENE S")
  })

  test("Acme LLC → entity, llc subtype", () => {
    const n = normalizeLegalName("Acme LLC")
    expect(n.isEntity).toBe(true)
    expect(n.entitySubtype).toBe("llc")
    expect(n.isPerson).toBe(false)
    expect(n.surname).toBeUndefined()
  })

  test("The Smith Family Trust → entity, trust subtype", () => {
    const n = normalizeLegalName("The Smith Family Trust")
    expect(n.isEntity).toBe(true)
    expect(n.isTrust).toBe(true)
    expect(n.entitySubtype).toBe("trust")
  })

  test("Estate of John Doe → entity, estate subtype", () => {
    const n = normalizeLegalName("Estate of John Doe")
    expect(n.isEntity).toBe(true)
    expect(n.isEstate).toBe(true)
    expect(n.entitySubtype).toBe("estate")
  })

  test('"Smith, John" → surname Smith, given John', () => {
    const n = normalizeLegalName("Smith, John")
    expect(n.surname).toBe("SMITH")
    expect(n.given).toBe("JOHN")
  })

  test('"John Smith Jr" strips suffix', () => {
    const n = normalizeLegalName("John Smith Jr")
    expect(n.suffix).toBe("JR")
    expect(n.surname).toBe("SMITH")
    expect(n.given).toBe("JOHN")
  })

  test("trustee capacity recognized", () => {
    const n = normalizeLegalName("Jane Doe, Trustee of the Doe Family Trust")
    expect(n.capacity).toBe("trustee")
  })

  test("successor trustee capacity recognized", () => {
    const n = normalizeLegalName("Jane Doe, Successor Trustee")
    expect(n.capacity).toBe("successor_trustee")
  })

  test("personal representative capacity", () => {
    const n = normalizeLegalName("Jane Doe, Personal Representative")
    expect(n.capacity).toBe("personal_representative")
  })

  test("decedent capacity", () => {
    const n = normalizeLegalName("John Doe, Deceased")
    expect(n.capacity).toBe("decedent")
  })

  test("AIF detected in 'A.I.F.' form", () => {
    const n = normalizeLegalName("Rene S. Kotter, A.I.F.")
    expect(n.capacity).toBe("AIF")
  })
})

describe("parseVesting", () => {
  test("two parties joined by 'and' with no form", () => {
    const v = parseVesting("John Smith and Jane Smith")
    expect(v.parties).toHaveLength(2)
    expect(v.vestingForm).toBeUndefined()
  })

  test("JTROS form", () => {
    const v = parseVesting("John Smith and Jane Smith, JTROS")
    expect(v.parties).toHaveLength(2)
    expect(v.vestingForm).toBe("JTROS")
  })

  test("'tenants in common' form", () => {
    const v = parseVesting("John Smith and Jane Smith, tenants in common")
    expect(v.parties).toHaveLength(2)
    expect(v.vestingForm).toBe("TIC")
  })

  test("ampersand connector", () => {
    const v = parseVesting("John Smith & Jane Smith")
    expect(v.parties).toHaveLength(2)
  })

  test("single entity does not split", () => {
    const v = parseVesting("Acme LLC")
    expect(v.parties).toHaveLength(1)
    expect(v.parties[0].entitySubtype).toBe("llc")
  })
})

describe("compareNames", () => {
  test("exact canonical match", () => {
    const a = normalizeLegalName("John Smith")
    const b = normalizeLegalName("john smith")
    expect(compareNames(a, b)).toBe("exact")
  })

  test("near match on initial vs full given", () => {
    const a = normalizeLegalName("J Smith")
    const b = normalizeLegalName("John Smith")
    expect(compareNames(a, b)).toBe("near")
  })

  test("different surnames → different", () => {
    const a = normalizeLegalName("John Smith")
    const b = normalizeLegalName("John Jones")
    expect(compareNames(a, b)).toBe("different")
  })

  test("entities require exact canonical", () => {
    const a = normalizeLegalName("Acme LLC")
    const b = normalizeLegalName("Acme L.L.C.")
    expect(compareNames(a, b)).toBe("different")
  })
})
