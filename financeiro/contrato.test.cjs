/* Testes de contrato sem dependências: node --test financeiro/contrato.test.cjs */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
assert.match(source, /\n  init\(\);\n\}\(\)\);/);
const isolated = source.replace(/\n  init\(\);\n\}\(\)\);/, '\n  // Não iniciar DOM durante os testes.\n}());');
const windowMock = {location: {search: '?teste_financeiro'}};
vm.runInNewContext(isolated, {window: windowMock, URLSearchParams, Intl, Date, Number, Set, Map, Object, Array, String, Math, Error, RegExp, JSON}, {timeout: 10000});
const u = windowMock.__financeiroTest;
const basic = [
  {fornecedor: 'SINTER PEÇAS', plano_contas: 'MATÉRIA-PRIMA', vencimento: '2026-11-12', valor: 100, pago: 1, conta: '001', tp: 'DUPLICATA'},
  {fornecedor: 'SINTER PEÇAS', plano_contas: 'MATÉRIA-PRIMA', vencimento: '2026-11-15', valor: '1.234,50', pago: 0, conta: '001', tp: 'DUPLICATA'},
  {fornecedor: 'TRANSPORTADORA', plano_contas: 'FRETE', vencimento: '13/11/2026', valor: '50,25', pago: 'NÃO'}
];

test('Campos e módulos essenciais estão presentes no HTML', () => {
  ['financeiro/app.js', 'financeiro/app.css'].forEach(name => assert.ok(html.includes(name.split('/')[1])));
  ['kpiTotal','kpiOpen','kpiPaid','kpiOverdue','kpiNext','dateFrom','dateTo','bySupplier','byPlan','byType','detailBody'].forEach(id => assert.ok(html.includes('id="' + id + '"')));
});
test('Não duplica lançamentos ao normalizar e aceita JSON plano', () => {
  const r = u.normalizePayload(basic).rows;
  assert.equal(r.length, 3);
  assert.equal(r.reduce((sum, x) => sum + x.value, 0), 1384.75);
  assert.equal(r[0].supplier, 'SINTER PEÇAS');
  assert.deepEqual(Array.from(r, x => x.status), ['PAGO', 'ABERTO', 'ABERTO']);
});
test('Entende a API em envelope recursivo', () => {
  const r = u.normalizePayload({data:{rows:basic}}).rows;
  assert.equal(r.length, 3);
});
test('Reconhece datas ISO, BR e números de calendário', () => {
  assert.equal(u.toDateKey('2026-11-13T00:00:00.000Z'), '2026-11-13');
  assert.equal(u.toDateKey('13/11/2026'), '2026-11-13');
  assert.equal(u.toDateKey('2026-02-30'), null);
});
test('Valores pt-BR, número, negativo e célula inválida', () => {
  assert.equal(u.numberStrict('R$ 12.345,67'), 12345.67);
  assert.equal(u.numberStrict('(1.200,50)'), -1200.50);
  assert.equal(u.numberStrict(0), 0);
  assert.equal(u.numberStrict('N/A'), null);
});
test('Não presume situação quando Pago não é reconhecido', () => {
  assert.equal(u.statusOf('SIM'), 'PAGO');
  assert.equal(u.statusOf('Não pago'), 'ABERTO');
  assert.equal(u.statusOf(true), 'PAGO');
  assert.equal(u.statusOf(null), 'DESCONHECIDO');
  assert.equal(u.statusOf('PARCIAL'), 'DESCONHECIDO');
});
test('Não aceita dados sem valor e data inválida, evitando total zero falso', () => {
  assert.throws(() => u.normalizePayload({data:[{valor:'--', vencimento:'2026-11-13'}]}), /valor monetário/);
  assert.throws(() => u.normalizePayload({rows:[{valor:10, vencimento:'2026-02-30'}]}), /data de vencimento/);
});
test('Não aceita páginas incompletas da API', () => {
  assert.throws(() => u.normalizePayload({data:[basic[0]], tem_mais:true}), /parte das contas/);
  assert.throws(() => u.normalizePayload({data:[basic[0]],total_registros:3}), /incompleta/);
});
test('Não exige valores em campos não críticos', () => {
  const r = u.normalizePayload([{valor:0, vencimento:null, pago:'', fornecedor:null}]).rows[0];
  assert.equal(r.value, 0);
  assert.equal(r.missingDate, true);
  assert.equal(r.supplier, 'Não informado');
  assert.equal(r.status, 'DESCONHECIDO');
});
