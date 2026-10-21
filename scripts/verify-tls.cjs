'use strict';

// Verify the selected OpenSSL store, then exercise both Node HTTPS clients.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const { X509Certificate } = require('node:crypto');

const blockedRoots = new Set([
  'D7A7A0FB5D7E2731D771E9484EBCDEF71D5F0C3E0A2948782BC83EE0EA699EF4',
  '86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B',
]);
assert((process.env.NODE_OPTIONS || '').split(/\s+/).includes('--use-openssl-ca'));
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
assert(!process.env.NODE_EXTRA_CA_CERTS, 'Unexpected additional CA store');
assert(process.env.SSL_CERT_FILE && process.env.SSL_CERT_DIR);
assert.equal(fs.readdirSync(process.env.SSL_CERT_DIR).length, 0);
const certificates = fs.readFileSync(process.env.SSL_CERT_FILE, 'utf8')
  .match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
assert(certificates.length >= 50, 'CA bundle is missing or incomplete');
for (const pem of certificates) {
  const fingerprint = new X509Certificate(pem).fingerprint256.replaceAll(':', '');
  assert(!blockedRoots.has(fingerprint), `Affected root remains: ${fingerprint}`);
}
if (process.argv.includes('--offline')) {
  console.log(`CA configuration verified (${certificates.length} roots)`);
  process.exit(0);
}

const hosts = [
  'emudhra.we-have-a-problem.com',
  'dv-g3b-emudhra.we-have-a-problem.com',
  'dv-g3b-aaa-emudhra.we-have-a-problem.com',
];
const certificateErrors = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_UNTRUSTED', 'CERT_REVOKED', 'SELF_SIGNED_CERT_IN_CHAIN',
]);
function request(host) {
  return new Promise(resolve => {
    const req = https.request({ hostname: host, method: 'HEAD', agent: false }, res => {
      res.resume(); resolve({ accepted: true, status: res.statusCode });
    });
    req.on('error', error => resolve({ accepted: false, code: error.code, message: error.message }));
    req.setTimeout(10000, () => req.destroy(new Error('HTTPS timeout')));
    req.end();
  });
}
async function fetchRequest(host) {
  try {
    const res = await fetch(`https://${host}/`, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
    return { accepted: true, status: res.status };
  } catch (error) {
    return { accepted: false, code: error.cause?.code || error.name, message: error.cause?.message || error.message };
  }
}
(async () => {
  for (const [index, host] of hosts.entries()) {
    for (const [client, run] of [['https', request], ['fetch', fetchRequest]]) {
      const result = await run(host);
      console.log(JSON.stringify({ host, client, ...result }));
      if (index === 0) assert(result.accepted, `${client}: normal HTTPS failed`);
      else assert(!result.accepted && certificateErrors.has(result.code), `${client}: expected certificate rejection`);
    }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
