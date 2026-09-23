/* Botão "Excluir minha conta" (paciente e profissional): pede a senha para confirmar */
window.AcoliaDeleteAccount = function (button, endpoint) {
  'use strict';
  const { $, api, modal } = window.Acolia;
  button.addEventListener('click', async () => {
    const done = await modal({
      title: 'Excluir minha conta',
      html: `<p>Tem certeza? Isso não pode ser desfeito.</p>
        <div class="form-error hidden" data-err></div>
        <div class="field"><label for="delPw">Digite sua senha para confirmar</label><input id="delPw" type="password" autocomplete="current-password"></div>`,
      actions: [{ label: 'Cancelar', value: false, class: 'secondary' }, {
        label: 'Excluir definitivamente', class: 'danger', handler: async (dlg) => {
          try {
            await api(endpoint, { method: 'POST', body: { password: $('#delPw', dlg).value } });
            return true;
          } catch (e) {
            const el = $('[data-err]', dlg); el.textContent = e.message; el.classList.remove('hidden');
            return false;
          }
        },
      }],
    });
    if (done) {
      await modal({ title: 'Conta excluída', html: '<p>Sua conta foi excluída. Obrigado por ter usado a Acolia.</p>' });
      location.href = '/';
    }
  });
};
