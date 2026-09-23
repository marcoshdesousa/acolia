/* "Excluir minha conta" (paciente e profissional): 3 confirmações — veja Acolia.deleteAccountFlow */
window.AcoliaDeleteAccount = function (button, endpoint) {
  'use strict';
  button.addEventListener('click', () => window.Acolia.deleteAccountFlow(endpoint.includes('professional') ? 'professional' : 'patient'));
};
