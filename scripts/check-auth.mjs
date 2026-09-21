// scripts/check-auth.mjs — verifica que los endpoints protegidos exigen autenticación
const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:4310';
const VALID = { Authorization: 'Bearer course-valid-token' };

async function check(label, path, headers, expected) {
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, { headers });
  } catch {
    console.error(`ERROR: no se pudo conectar a ${BASE_URL} (¿está levantado el backend?)`);
    process.exit(2);
  }
  const ok = res.status === expected;
  console.log(`${ok ? 'OK   ' : 'FALLO'} ${label}: esperado ${expected}, recibió ${res.status}`);
  return ok;
}

const results = [
  await check('GET /v1/resources sin token', '/v1/resources', {}, 401),
  await check('GET /v1/resources token inválido', '/v1/resources', { Authorization: 'Bearer token-falso' }, 401),
  await check('GET /v1/resources token válido', '/v1/resources', VALID, 200),
  await check('GET /v1/incidents sin token', '/v1/incidents', { 'X-Course-Actor': 'reporter-1' }, 401),
];

if (results.includes(false)) {
  console.error('Control de autenticación NO verificado');
  process.exit(1);
}
console.log('Control verificado: rechaza sin token o con token inválido y acepta el token válido');