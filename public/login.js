const $ = s => document.querySelector(s);
const TV = /SMART-?TV|Tizen|Web0S|WebOS|Android TV|AFT|CrKey|BRAVIA|HbbTV|GoogleTV|NetCast|VIDAA|Roku/i.test(navigator.userAgent)
  || /[?&]tv=1/.test(location.search);
if (TV) { document.documentElement.classList.add('tv'); document.body.classList.add('kb'); }
document.addEventListener('keydown', () => document.body.classList.add('kb'));

let modo = 'entrar';   // 'entrar' | 'criar'

/* ================================================================
   PONTO DE INTEGRAÇÃO: único lugar que fala com o backend.
   Deve resolver em caso de sucesso e lançar um erro (com .code) em caso de falha.
   ================================================================ */
async function autenticar({ modo, email, senha, manter }) {
  throw Object.assign(new Error('backend não conectado'), { code: 'nao-implementado' });
}
async function recuperarSenha(email) {
  throw Object.assign(new Error('backend não conectado'), { code: 'nao-implementado' });
}

// Traduz códigos (os do Firebase já estão mapeados) para mensagens humanas.
const MSG = {
  'auth/invalid-credential':      'E-mail ou senha incorretos.',
  'auth/invalid-email':           'Digite um e-mail válido.',
  'auth/email-already-in-use':    'Este e-mail já está cadastrado.',
  'auth/weak-password':           'A senha precisa ter pelo menos 6 caracteres.',
  'auth/too-many-requests':       'Muitas tentativas. Aguarde um pouco e tente de novo.',
  'auth/network-request-failed':  'Sem conexão com o servidor.',
  'nao-implementado':             'Login ainda não conectado ao backend.',
};
const traduz = e => MSG[e.code] || 'Não foi possível concluir. Tente novamente.';

const erro = t => { $('#erro').textContent = t || ''; };
const busy = b => { $('#ok').disabled = b; $('#ok').textContent = b ? 'Aguarde…' : (modo === 'entrar' ? 'Entrar' : 'Criar conta'); };

function alternar() {
  modo = modo === 'entrar' ? 'criar' : 'entrar';
  const novo = modo === 'criar';
  $('#titulo').textContent   = novo ? 'Criar conta' : 'Entrar';
  $('#ok').textContent       = novo ? 'Criar conta' : 'Entrar';
  $('#pergunta').textContent = novo ? 'Já tem conta?' : 'Novo por aqui?';
  $('#troca').textContent    = novo ? 'Entrar' : 'Criar conta';
  $('#esqueci').hidden       = novo;
  $('#senha').autocomplete   = novo ? 'new-password' : 'current-password';
  $('#senha').minLength      = novo ? 6 : 0;
  document.title = 'JoãoFlix · ' + $('#titulo').textContent;
  erro('');
}

$('#troca').onclick = alternar;

$('#olho').onclick = () => {
  const mostrar = $('#senha').type === 'password';
  $('#senha').type = mostrar ? 'text' : 'password';
  $('#olho').setAttribute('aria-pressed', mostrar);
  $('#olho').setAttribute('aria-label', mostrar ? 'Ocultar senha' : 'Mostrar senha');
};

$('#f').onsubmit = async e => {
  e.preventDefault();
  erro('');
  const email = $('#email').value.trim(), senha = $('#senha').value;
  if (!$('#email').checkValidity()) return erro('Digite um e-mail válido.'), $('#email').focus();
  if (!senha) return erro('Digite sua senha.'), $('#senha').focus();
  if (modo === 'criar' && senha.length < 6) return erro(MSG['auth/weak-password']), $('#senha').focus();

  busy(true);
  try {
    await autenticar({ modo, email, senha, manter: $('#manter').checked });
    location.href = '/perfis.html';
  } catch (err) {
    erro(traduz(err));
    $('#senha').select();
  } finally { busy(false); }
};

$('#esqueci').onclick = async () => {
  if (!$('#email').checkValidity() || !$('#email').value) return erro('Digite seu e-mail acima primeiro.'), $('#email').focus();
  try { await recuperarSenha($('#email').value.trim()); erro('Enviamos um link de redefinição para o seu e-mail.'); }
  catch (err) { erro(traduz(err)); }
};

$('#email').focus();