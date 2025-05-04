import type { Approved, Template } from "./convert.js"

const DEMOGRAPHICS =
  `{"id":{"at":1},"name":[{"family":{"at":2},"given":[{"at":3}]}],` +
  `"gender":{"at":4,"map":{"M":"male","F":"female"}},` +
  `"birthDate":{"at":5}}`

const CONTACT =
  `{"id":{"at":1},"telecom":[{"system":{"at":2,` +
  `"map":{"PH":"phone","EM":"email"}},"value":{"at":3},"use":"home"}]}`

export const PACK: ReadonlyArray<Template> = [
  { id: "demographics-v1", body: DEMOGRAPHICS },
  { id: "contact-v1", body: CONTACT }
]

export const APPROVED: ReadonlyArray<Approved> = [
  {
    id: "demographics-v1",
    target: "Patient",
    digest: "6199ad7876849af4ab33fd10ffa19d724e5fe0be7fd704025b2d8e27e3696069"
  },
  {
    id: "contact-v1",
    target: "Patient",
    digest: "e32f4bb6ae3c768cab11979bf859175eedd7ba431f2b9480411cb97de3f7d1a7"
  }
]

export const templateOf = (
  offered: ReadonlyArray<Template>,
  id: string
): Template | undefined => offered.find((held) => held.id === id)
