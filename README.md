# Acolia — Psicologia online

Plataforma que funciona como **vitrine** de profissionais de saúde mental (psicólogos, psicanalistas, psiquiatras…), com **chat estilo WhatsApp** e **atendimento por vídeo/voz** dentro do próprio site. Pode ser instalada no celular como aplicativo (PWA).

## As três áreas

| Área | Endereço | O que faz |
|---|---|---|
| Administrador geral | `/admin` | Aprova/recusa cadastros de profissionais, cadastra profissionais, restringe/bloqueia, controla a mensalidade, vê e filtra pacientes e profissionais por estado/município, bloqueia pacientes, gera nova senha, exporta planilha (CSV). **Não tem acesso às mensagens nem às chamadas.** |
| Profissional | `/cadastro-profissional`, `/painel` | Cadastro com registro (CRP/CRM), e-mail e WhatsApp → recebe um **código único** (anotar/printar). Após aprovação: perfil (foto, nome, registro, valor da consulta, pacotes, estado/município, clínica presencial opcional, chave Pix, duração da sessão, Instagram, galeria de até 6 fotos e link do Google Maps da clínica (mini mapa só para quem tem conta) — visitante vê localização, Instagram e as 2 primeiras fotos; valores, "Sobre", endereço e o resto da galeria só com conta), chat com pacientes (arquivar/desarquivar, enviar Pix), criar atendimento. |
| Paciente | `/cadastro-paciente`, `/app` | Cadastro com nome completo, CPF válido, estado/município e senha. Login com CPF + senha. Vitrine com os da sua cidade primeiro, busca por nome, estado, município e localidade, favoritos (coração), chat, configurações (foto e nome exibido). |

Sem conta, o visitante vê os profissionais na página inicial, mas **sem valores e sem localização**.

## Atendimento (chamada)

1. O profissional cria o atendimento informando o nome (real ou fictício) do paciente — pelo painel ou direto no chat.
2. É gerado um código para o paciente, que começa com os **2 primeiros caracteres do código do profissional** + 6 caracteres aleatórios (letras e números).
3. O profissional (logado) entra pelo botão **Entrar na chamada** de cada atendimento no painel; o paciente, com o **código dele** em `/atendimento`.
4. Vídeo e voz. Os dois podem ligar/desligar a câmera e o microfone.
5. O profissional pode ter **até 2 atendimentos abertos ao mesmo tempo**. Ao clicar em **Finalizar atendimento**, o código do paciente deixa de funcionar.
6. A chamada continua se a pessoa sair da tela para usar outro app: onde o navegador permite, vai para uma **janelinha flutuante** com a outra pessoa grande e você pequeno no canto (botão ao lado da câmera; no Chrome e no Safari ela também abre sozinha ao trocar de app).
7. Câmera desligada não fica preta nem congelada: aparece a foto de perfil (ou as iniciais) num fundo da marca, na tela e na janelinha.

No chat, paciente e profissional podem mandar **mensagens de voz** no estilo WhatsApp (barrinhas da voz ao vivo, parar e ouvir antes de enviar; até 5 minutos). O áudio é gravado em WAV, que toca em qualquer celular, fica numa pasta privada e só quem participa da conversa ouve. Fotos e vídeos não são aceitos.

O profissional só vê uma conversa depois que o paciente manda a primeira mensagem — o profissional nunca inicia conversa.

A chamada é ponto a ponto (WebRTC): o áudio e o vídeo não passam pelo servidor nem ficam gravados.

## App e notificações

O site pode ser instalado como app (Android, iPhone e computador) pelo próprio site, sem loja. As páginas de entrada e o rodapé têm um tutorial de instalação por aparelho. Depois de instalar e tocar em **Ativar notificações**, paciente e profissional recebem cada mensagem nova como notificação, mesmo com o app fechado (Web Push). As chaves de notificação são criadas sozinhas e ficam guardadas no banco. No iPhone, as notificações só funcionam com o app instalado (iOS 16.4 ou mais novo).

## Mensagens

Não podem ser editadas. Quem enviou pode **apagar a própria mensagem para todos**, a qualquer momento: o conteúdo (e o arquivo do áudio) sai do banco e no lugar fica "Mensagem apagada" (o banco tem gatilhos que impedem qualquer outra alteração). Cada lado pode arquivar a conversa; ela continua disponível em "Arquivadas".

## Colocar no ar com um clique

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/marcoshdesousa/acolia)

O botão cria o site no plano **Starter** do Render (cerca de US$ 7/mês) com um **disco permanente de 1 GB** montado em `/var/data`. Tudo fica guardado ali para sempre, mesmo quando o site é atualizado ou reinicia: contas, logins, mensagens, atendimentos, fotos e carteirinhas. O botão só pede a senha do administrador (`ADMIN_PASSWORD`).

O Render faz um snapshot diário do disco, que pode ser restaurado pelo painel dele em **Disks**.

**Alternativa grátis:** no plano free não há disco. Nesse caso, defina `SUPABASE_URL` e `SUPABASE_SERVICE_KEY` para os dados ficarem guardados no Supabase Storage. O site baixa o banco ao ligar e envia uma cópia depois de cada alteração (ver `server/cloud.js`).

## Como rodar

Requer **Node.js 22.13+** (usa o SQLite embutido do Node, sem instalar banco).

```bash
npm install
ADMIN_PASSWORD='uma-senha-forte' npm start
# abre em http://localhost:3000
```

Na primeira execução é criado o administrador (`admin` / a senha de `ADMIN_PASSWORD`; se não for definida, uma senha aleatória aparece no terminal). Troque a senha em `/admin` → Conta.

Testes: `npm test`

### Variáveis de ambiente

| Variável | Uso |
|---|---|
| `PORT` | Porta (padrão 3000) |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Administrador criado na primeira execução |
| `DATA_DIR` | Pasta do banco e das fotos (padrão `./data`) — **faça backup dela** |
| `COOKIE_SECURE=true` | Use em produção com HTTPS |
| `TRUST_PROXY=true` | Se estiver atrás de proxy (Nginx, Render, Railway…) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_BUCKET` | Guardar os dados no Supabase (ver acima) |
| `PUSH_CONTACT` | E-mail de contato enviado aos serviços de notificação (padrão `mailto:contato@acolia.com.br`) |
| `ICE_SERVERS` | JSON com servidores STUN/TURN para as chamadas (ver abaixo) |
| `CPF_API_URL`, `CPF_API_TOKEN`, `CPF_API_NAME_FIELD` | Conferência do nome com o CPF na Receita (ver abaixo) |
| `REGISTRY_API_URL`, `REGISTRY_API_TOKEN`, `REGISTRY_API_NAME_FIELD`, `REGISTRY_API_ACTIVE_FIELD` | Consulta automática do CRP/CRM no conselho (ver abaixo) |

## Importante antes de colocar no ar

- **HTTPS é obrigatório**: navegadores só liberam câmera/microfone e instalação do app em sites com HTTPS.
- **Conferir se o nome bate com o CPF**: o sistema sempre valida os dígitos do CPF (bloqueia CPF inventado). Já saber se o nome pertence ao CPF só é possível consultando a Receita Federal por um serviço **pago**, como o SERPRO *Consulta CPF*. Com o contrato em mãos, configure `CPF_API_URL` (ex.: `https://gateway.apiserpro.serpro.gov.br/consulta-cpf-df/v2/cpf/{cpf}`) e `CPF_API_TOKEN`; a partir daí o cadastro só é aceito se o nome conferir, e o admin vê a marca "conferido".
- **Carteirinha do profissional**: no autocadastro, o sistema confere o formato do CRP (região/número) ou CRM e se o conselho regional é do mesmo estado informado; a foto da carteirinha é obrigatória e fica numa pasta privada que só o admin vê, para conferir nome e endereço antes de aprovar. Nome e registro não podem ser trocados pelo profissional depois. Os conselhos (CFP/CFM) não oferecem API pública gratuita; com um serviço contratado, configure `REGISTRY_API_URL` (com `{tipo}`, `{uf}` e `{numero}`) e `REGISTRY_API_TOKEN` para bloquear automaticamente registro inexistente, inativo ou de outro nome. Psicanalistas e terapeutas não têm conselho federal: para eles vale a conferência manual da carteirinha da entidade. O admin, ao cadastrar um profissional, pode usar qualquer registro.
- **Servidor TURN**: sem ele, algumas chamadas entre redes muito restritas (algumas operadoras 4G, redes corporativas) não conectam. Contrate um (ex.: Twilio, Metered, ou instale o coturn) e informe em `ICE_SERVERS`, ex.:
  `[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.seudominio.com:3478","username":"u","credential":"s"}]`
- **Recuperação de senha do paciente** usa CPF + nome completo, como pedido. Esses dados não são segredo; se quiser mais segurança, dá para trocar por código via e-mail/SMS.
- **LGPD**: a plataforma guarda CPF e dados de saúde sensíveis. Tenha termos de uso e política de privacidade redigidos por um profissional.


## Versões

| Versão | Commit | O que tem |
|---|---|---|
| **1.1** | `81011a7` | Vitrine, chat com áudio, atendimento por vídeo, painel do admin |
| **1.2** | (esta) | Tudo da 1.1 + **Início estilo Instagram** |

### Versão 1.2 — Início estilo Instagram (só para quem tem conta)
- Navegação só com símbolos: 🏠 Início, 👤 Profissionais, 💬 Mensagens, ⚙️ Configurações (o profissional tem também 🎥 Atendimento e o próprio perfil). A barra é flutuante, arredondada e meio transparente (efeito vidro), com o botão ativo destacado; encolhe quando a pessoa rola para baixo e volta ao subir. No computador é a mesma barra, um pouco maior.
- **Início**: stories no topo e o feed de quem a pessoa segue. As publicações que ela ainda não viu aparecem primeiro; as já vistas descem.
- **Publicações**: só profissionais publicam, pela **cruz (+)** do Início (escolhe "Publicar fotos" ou "Publicar story"). Cada publicação tem **de 1 a 10 fotos** (carrossel, arrasta para o lado) e uma descrição para todas. No perfil aparecem só as **4 publicações** mais recentes (com o ícone de "várias fotos" quando for carrossel); "Ver todas as fotos" abre a **página de publicações** (grade com rolagem e "Voltar para o perfil"); a descrição, as curtidas e os comentários aparecem ao abrir. As publicações ficam no perfil até o profissional apagar (⋮).
- **Publicação no story**: o dono da publicação tem o botão ⭐+ (estrela com cruzinha) — só ele vê. Tocando, a publicação vai para o story dele; quem vê o story toca na publicação e ela abre (com todas as fotos). Outro profissional não consegue colocar a publicação de alguém no story dele.
- **Stories**: só profissionais postam (foto ou vídeo de até 20 s, quantos quiserem). Somem depois de 24 h. Quem segue vê e curte; o paciente também tem "Enviar mensagem".
- **Seguir**: pacientes e profissionais seguem profissionais. O perfil mostra só os números (seguidores / seguindo), nunca a lista.
- **Curtir** com o símbolo da Acolia (fica vermelho). Não mostra quem curtiu.
- **Comentários** (só texto). Paciente aparece com o 1º e o 2º nome e a cidade; profissional com o nome, que abre o perfil. Cada um apaga o próprio comentário; o dono da publicação apaga qualquer um.
- **Compartilhar** (aviãozinho): manda o link `site.com/p/<número>` (por exemplo, pelo WhatsApp). Quem recebe só vê a publicação se entrar ou criar conta.
- **Notificações** (sininho no Início): "Um paciente/profissional começou a seguir você", "Sua publicação recebeu uma curtida", "<nome> comentou…", "<nome> curtiu seu story".
- Profissional **não** manda mensagem para profissional (só segue, curte e comenta).
- A página inicial do site (sem conta) continua igual.
- As fotos da antiga galeria de 6 fotos viraram as primeiras publicações de cada profissional.

### Voltar para a versão 1.1
O banco só **ganhou** tabelas novas na 1.2 — nenhuma conta, mensagem ou dado da 1.1 foi alterado. Por isso dá para voltar e depois vir de novo sem perder nada (na 1.1 as publicações e stories só ficam guardados, sem aparecer).
1. No Render, abra o serviço **acolia** → **Events** (ou **Deploys**).
2. Ache o deploy do commit **`81011a7`** ("Vitrine do paciente: filtro automático aparece no botão Filtrar").
3. Clique em **Rollback** e confirme. Em alguns minutos o site volta para a 1.1.
4. Para voltar para a 1.2, faça o mesmo com o deploy mais recente (ou clique em **Manual Deploy → Deploy latest commit**).
