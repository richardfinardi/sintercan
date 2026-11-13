/* Verificação ao vivo sem persistir ou imprimir os dados financeiros.
   node financeiro/live-smoke.cjs
   Usar somente na branch de homologação.
*/
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const js = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const isolated = js.replace(/\n  init\(\);\n\}\(\)\);/, '\n}());');
const windowMock = {location: {search: '?teste_financeiro'}};
vm.runInNewContext(isolated, {window: windowMock, URLSearchParams, Intl, Date, Number, Set, Map, Object, Array, String, Math, Error, RegExp, JSON}, {timeout: 10000});
const u = windowMock.__financeiroTest;

(async () => {
  const url = process.env.ENDPOINT_CONTAS_PAGAR || 'https://sintercan.consultoriarf.net/contas_pagar';
  const result = await fetch(url, {headers: {Accept: 'application/json'}, cache: 'no-store', signal: AbortSignal.timeout(120000)});
  if (!result.ok) throw new Error('Resposta HTTP ' + result.status);
  const payload = await result.json(); // Nunca imprimir ou gravar a resposta.
  const parsed = u.normalizePayload(payload);
  const r = parsed.rows;
  if (r.length === 0) throw new Error('Endpoint vazio. Homologação interrompida.');
  const unknown = r.filter(x => x.status === 'DESCONHECIDO').length;
  const missingDue = r.filter(x => !x.dateKey).length;
  const missingSupplier = r.filter(x => x.supplier === 'Não informado').length;
  const sum = r.reduce((s, x) => s + x.value, 0);
  if (!Number.isFinite(sum)) throw new Error('Soma não finita.');
  console.log('Estrutura: válida; linhas: ' + r.length + '; Pago não reconhecido: ' + unknown + '; Sem vencimento: ' + missingDue + '; Sem fornecedor: ' + missingSupplier);
  console.log('Colunas identificadas: ' + parsed.sourceFields.join(' | '));
  if (unknown) throw new Error('Há registros cuja situação Pago é desconhecida; não homologar os totais por situação.');
  console.log('VALIDAÇÃO AO VIVO OK. Dados e valores individuais não foram registrados.');
})().catch(e => {console.error('VALIDAÇÃO AO VIVO FALHOU: ' + (e && e.message || e)); process.exitCode = 1;});
