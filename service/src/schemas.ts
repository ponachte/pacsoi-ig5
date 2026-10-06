export const CONTEXT = {
  fhir: "http://hl7.org/fhir/",
  foaf: "http://xmlns.com/foaf/0.1/",
  prov: "http://www.w3.org/ns/prov#",
  saref: "https://saref.etsi.org/core/",
  snomed: "http://snomed.info/id/",
  sosa: "http://www.w3.org/ns/sosa/",
  sphn: "https://sphn.ch/",
};

export const PATIENT_SCHEMA = `
type Query { patients: [Patient!]! }
type Patient @class(iri: "http://xmlns.com/foaf/0.1/Person") { id: ID! }
type Subscription {
  onPatientAdded: Patient!
  onPatientRemoved: Patient!
}`;

export const PROCEDURE_SCHEMA = `
type Query { bariatricProcedures: [MedicalProcedure!]! }
type MedicalProcedure @class(iri: "https://sphn.ch/MedicalProcedure") {
  id: ID!
  prov_type: ID! @predicate(iri: "http://www.w3.org/ns/prov#type")
  prov_startedAtTime: DateTime! @predicate(iri: "http://www.w3.org/ns/prov#startedAtTime")
  subject: ID! @predicate(iri: "https://sphn.ch/hasIntervention", reverse: true)
}
type Subscription { onbariatricProcedureAdded: MedicalProcedure! }
`;

export const WEIGHT_SCHEMA = `
type Query { weightObservations: [WeightObservation!]! }
type WeightObservation @class(iri: "http://www.w3.org/ns/sosa/Observation") {
  id: ID!
  sosa_hasFeatureOfInterest: ID! @predicate(iri: "http://www.w3.org/ns/sosa/hasFeatureOfInterest")
  sosa_hasResult: WeightValue! @predicate(iri: "http://www.w3.org/ns/sosa/hasResult")
  sosa_observedProperty: ID!
    @predicate(iri: "http://www.w3.org/ns/sosa/observedProperty")
    @filter(if: "it=='http://snomed.info/id/27113001'")
}
type WeightValue @class(iri: "https://saref.etsi.org/core/PropertyValue") {
  id: ID!
  saref_isValueOfProperty: ID!
    @predicate(iri: "https://saref.etsi.org/core/isValueOfProperty")
    @filter(if: "it=='http://snomed.info/id/27113001'")
  saref_hasValue: Float! @predicate(iri: "https://saref.etsi.org/core/hasValue")
  saref_hasTimestamp: DateTime! @predicate(iri: "https://saref.etsi.org/core/hasTimestamp")
}
type Subscription { onWeightObservationAdded: WeightObservation! }
`;

export const PATIENT_QUERY = `
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT ?patient WHERE { ?patient a foaf:Person . }`;

export const PROCEDURE_QUERY = `
PREFIX sphn: <https://sphn.ch/>
PREFIX prov: <http://www.w3.org/ns/prov#>
SELECT ?patient ?timestamp WHERE {
  ?patient sphn:hasIntervention ?procedure .
  ?procedure a sphn:MedicalProcedure ;
    prov:type <http://snomed.info/id/442338001> ;
    prov:startedAtTime ?timestamp .
}`;

export const WEIGHT_QUERY = `
PREFIX saref: <https://saref.etsi.org/core/>
PREFIX sosa: <http://www.w3.org/ns/sosa/>
SELECT ?patient ?value ?timestamp WHERE {
  ?observation a sosa:Observation ;
    sosa:hasFeatureOfInterest ?patient ;
    sosa:observedProperty <http://snomed.info/id/27113001> ;
    sosa:hasResult ?result .
  ?result a saref:PropertyValue ;
    saref:isValueOfProperty <http://snomed.info/id/27113001> ;
    saref:hasValue ?value ;
    saref:hasTimestamp ?timestamp .
}`;
