import test from "node:test";
import assert from "node:assert/strict";
import { anonymousReaderGrant, hasAnonymousReaderGrant } from "../src/kvasir/rebac.js";

test("anonymous grant assigns reader on the slice root", () => {
  const grant = anonymousReaderGrant("https://kvasir.example/pod/slices/test");
  assert.equal(grant["kss:insert"][0]["@id"], "urn:kvasir-user:anonymous");
  assert.equal(grant["kss:insert"][0]["kss-fga:reader"]["@id"], "https://kvasir.example/pod/slices/test");
});

test("anonymous grant can explicitly target a slice query resource", () => {
  const resource = "https://kvasir.example/pod/slices/test/query";
  const grant = anonymousReaderGrant(resource);
  assert.equal(grant["kss:insert"][0]["@id"], "urn:kvasir-user:anonymous");
  assert.equal(grant["kss:insert"][0]["kss-fga:reader"]["@id"], resource);
});

test("existing anonymous reader grants are recognized", () => {
  const resource = "https://kvasir.example/pod/slices/test";
  const listing = { "@graph": [anonymousReaderGrant(resource)["kss:insert"][0]] };
  assert.equal(hasAnonymousReaderGrant(listing, resource), true);
  assert.equal(hasAnonymousReaderGrant(listing, `${resource}-other`), false);
});
