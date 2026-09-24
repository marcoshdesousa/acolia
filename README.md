# Acolia — Psicologia online

Plataforma que funciona como **vitrine** de profissionais de saúde mental (psicólogos, psicanalistas, psiquiatras…), com **chat estilo WhatsApp** e **atendimento por vídeo/voz** dentro do próprio site. Pode ser instalada no celular como aplicativo (PWA).

## As três áreas

| Área | Endereço | O que faz |
|---|---|---|
| Administrador geral | `/admin` | Aprova/recusa cadastros de profissionais, cadastra profissionais, restringe/bloqueia, controla a mensalidade, vê e filtra pacientes e profissionais por estado/município, bloqueia pacientes, gera nova senha, exporta planilha (CSV). **Não tem acesso às mensagens nem às chamadas.** |
| Profissional | `/cadastro-profissional`, `/painel` | Cadastro com e-mail e WhatsApp; **número e foto da carteirinha só para psicólogo/neuropsicólogo (CRP) e psiquiatra (CRM)** — psicanalista, psicoterapeuta e terapeuta não enviam carteirinha → recebe um **código único** (anotar/printar). Após aprovação: perfil (foto, nome, registro, valor da consulta, pacotes, estado/município, clínica presencial opcional, chave Pix, duração da sessão, Instagram, galeria de até 6 fotos e link do Google Maps da clínica (mini mapa só para quem tem conta) — visitante vê localização, Instagram e as 2 primeiras fotos; valores, "Sobre", endereço e o resto da galeria só com conta), chat com pacientes (arquivar/desarquivar, enviar Pix), criar atendimento. |
| (perfil) | — | O "Sobre" aparece resumido no perfil (4 linhas) com **Ler mais**, que abre uma página com a história completa e botão Voltar. **Aceito plano de saúde** (chavezinha no perfil do profissional): aparece no perfil, nos valores e na vitrine; vale para online e presencial — os detalhes o paciente pergunta pelo chat. |
| Paciente | `/cadastro-paciente`, `/app` | Cadastro com nome completo (igual ao do CPF), CPF válido, **data de nascimento** (menor de idade pode criar conta, sem documento dos pais), estado/município e senha. Login com CPF + senha. Vitrine com os da sua cidade primeiro, busca por nome, estado, município e localidade, favoritos (coração), chat, configurações (foto, nome exibido, estado/município e senha). **Nome completo, CPF e data de nascimento não mudam** (vão nos documentos). Conta antiga sem data de nascimento: o app pede e **não deixa continuar** até informar. |

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
- **Uma a uma → apagar para todos** (só as suas mensagens, pelo ⋮ da mensagem): o conteúdo sai do banco (áudio também), os dois lados (você e o outro) veem "Mensagem apagada".
- **Limpar conversa** (⋮ da conversa): apaga todas as mensagens (as suas e as do outro) **só para você**; o outro continua vendo.
- Quando **os dois** limparam/apagaram a mesma mensagem, ela **sai do banco de vez**.
- **Bloquear** (⋮ da conversa → "Bloquear paciente/profissional"): só as mensagens — ninguém manda mensagem nessa conversa e ela é limpa para quem bloqueou. O paciente continua vendo o perfil, fotos e vídeos do profissional (para não ver, é só deixar de seguir). Desbloquear em **Conversas → Bloqueados**.
- **Conta apagada**: as conversas dela somem por completo (mensagens dos dois lados, áudios e a conversa).

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
- **Senhas**: o paciente cria a senha no cadastro; se esquecer, informa **nome completo + CPF + data de nascimento** e cria uma senha nova na hora. O profissional **não cria senha no cadastro**: ao aprovar, o admin vê a primeira senha (uma vez só) e manda pelo WhatsApp; depois ele troca em Conta. As senhas nunca ficam guardadas de forma legível — se alguém esquecer, o admin gera uma nova (paciente ou profissional). O profissional pode mudar WhatsApp e e-mail; profissão, registro e código só a administração.
- **LGPD**: a plataforma guarda CPF e dados de saúde sensíveis. Tenha termos de uso e política de privacidade redigidos por um profissional.


## Documentos do profissional (no chat)
Botão 📄 no chat do profissional → escolhe o documento → **assina com o dedo** no quadro (a assinatura vai na folha, acima do nome e do registro, e só vale para aquele documento; se cancelar, é descartada) → confere os dados → **Enviar documento**. Nome completo (o do CPF, não o nome exibido), CPF e data de nascimento vêm **travados do cadastro do paciente** — o servidor usa sempre os dados da conta, então batem com o documento dele. Só se a conta for antiga e ainda não tiver data de nascimento o profissional digita. O horário do último atendimento já vem preenchido (dá para corrigir). O documento chega na conversa e o paciente **vê, salva a imagem ou compartilha**.
- **Quem pode emitir**: **Receita** (medicamentos) → só **Psiquiatra (CRM)**. **Atestado** → Psiquiatra ("Atestado médico", CFM Res. 1.658/2002) e **Psicólogo(a) / Neuropsicólogo(a)** ("Atestado psicológico", CFP Res. 06/2019) — sempre **1 dia** (o do atendimento); CID só com autorização do paciente. **Encaminhamento** (presencial ou online) → **todos**. **Laudo**: não é feito pela plataforma.
- **Conta de teste do profissional** (código 123456789): emite **tudo** (receita, atestado e encaminhamento), com os dados reais do paciente, mas o documento sai com o nome/registro de teste, a marca **"TESTE — SEM VALIDADE"**, e a verificação pública diz que não tem validade.
- A folha sai com o nome completo e o registro (CRM/CRP) do profissional, "assinado eletronicamente" com data e hora, **código de verificação + QR Code** e, no rodapé, o símbolo e o nome da Acolia com o aviso de que o conteúdo é responsabilidade do profissional.
- **Verificação pública**: `site.com/v/CÓDIGO` (ou o QR Code) mostra se o documento é válido, quem emitiu e para quem (CPF mascarado). Se o profissional apagar a mensagem do documento para todos, ele fica **cancelado**.
- Medicamentos controlados (tarja preta, receita azul/amarela — Portaria 344/98) não devem ser prescritos por aqui (o formulário avisa).

## Leve e rápido (menos internet)
- Páginas, CSS e JS vão **compactados** (Brotli/gzip, ~75% menores) e com ETag: o que não mudou volta como "304" (quase 0 bytes). JSON grande da API também vai compactado.
- Logo e ícones otimizados (ex.: símbolo 86 KB → 11 KB) e a logo vem direto na página (aparece na hora).
- O app guarda no aparelho: CSS/JS/ícones (abre na hora e atualiza por baixo), as páginas principais (sem internet abre a última versão) e as **fotos já vistas** (até 300; não baixa de novo). Vídeos não são guardados (tocam aos pouquinhos).
- Grade do perfil usa a miniatura (600 px) em vez da foto inteira; foto de perfil é enviada com 640 px.
- **Espaço usado**: no topo do painel do admin (sempre visível: "X de 3 GB (%)" — verde, amarelo a partir de 60%, vermelho a partir de 80%) e, na Visão geral, aparece "Espaço usado no disco" (X GB de 3 GB, com a barrinha) e quanto é de fotos, vídeos, áudios, documentos e banco; fica vermelho acima de 80%.
- **Sem internet**: aparece a faixa "Você está sem internet" no topo; quando volta, "Conexão de volta" por 2 s e some. Se o app abrir sem internet, ele espera e recarrega sozinho quando a conexão voltar.

## Bloquear e apagar contas
- **Apagar** (admin, qualquer conta, em Pacientes ou no detalhe do profissional → "Apagar conta", com dois avisos: "Apagar esta conta?" e "Tem certeza?"; o admin não digita CPF nem código): some tudo — dados pessoais, foto, publicações, reels e stories (com os arquivos), curtidas, comentários, seguidores e o conteúdo das mensagens que a pessoa mandou (para o outro lado fica "Mensagem apagada"). CPF, e-mail, registro, código e link ficam livres: a pessoa pode criar uma conta nova.
- **Início oficial (uma vez só)**: na primeira subida desta versão, todas as contas criadas até então (pacientes, profissionais e as contas de teste) e tudo o que fizeram (publicações, reels, stories, fotos, vídeos, conversas, áudios, documentos, atendimentos) são apagados do banco, do disco e da nuvem. Ficam o administrador, o perfil oficial Acolia Brasil e as configurações. CPFs, e-mails e registros ficam livres. As contas de teste voltam só pelo botão **Criar contas de teste** do admin.
- **Admin cadastrando profissional**: psicólogo, neuropsicólogo e psiquiatra só com CRP/CRM válido e do mesmo estado (com a consulta ao conselho configurada, o nome também precisa bater). Psicanalista, psicoterapeuta e terapeuta entram sem registro.
- **Lista de bloqueados**: quem o admin bloqueia continua bloqueado mesmo se apagar a própria conta — se criar outra com o mesmo CPF (paciente) ou o mesmo e-mail, registro ou WhatsApp (profissional), a conta nova já nasce bloqueada. Só o admin libera (desbloqueando). Se o **admin apagar** a conta, a pessoa pode criar de novo normalmente (profissional passa de novo pela aprovação).
- **Cadastro de profissional em 3 passos**: (1) dados → botão **Próximo** (confere os campos antes de seguir); (2) **Escolha o seu plano**: hoje só existe o **Plano Mensal — R$ 30,00 a cada 30 dias** (100% do valor das consultas, publicar fotos, vídeos, textos e stories, pacientes ilimitados); é preciso marcar o plano e tocar em **Avançar** ("Voltar" mantém os dados); (3) **"Sua conta está quase pronta!"** com o código, o aviso "Em breve alguém da nossa equipe irá entrar em contato com você pelo WhatsApp para enviar a sua senha" e o botão **Mandar mensagem para a equipe** (WhatsApp com "Olá, sou profissional, acabei de criar minha conta."). Se algum dado já existir (e-mail, registro), volta para o formulário mostrando o aviso. O plano escolhido aparece no painel do admin, nos detalhes do profissional. Ao tentar entrar antes da aprovação aparece "Seus dados estão sendo analisados pela nossa equipe" com o botão do WhatsApp. O WhatsApp é obrigatório no cadastro.
- **Bloquear** (admin): a pessoa ainda entra, mas só vê a tela **"Perfil bloqueado"** com o botão **"Falar com o administrador"** (abre o WhatsApp de atendimento, 11 93902-3938; dá para trocar pela variável `SUPPORT_WHATSAPP`) e, embaixo, um link pequeno "Excluir conta permanentemente" (3 confirmações: "Excluir sua conta?" → "Tem certeza? Se apagar, já era" → digitar o CPF (paciente) ou o código de acesso (profissional)). Não vê feed, Reels, pacientes nem edita o perfil. Os dados ficam guardados e o perfil some para todos. Quem está com o app aberto vê a tela de bloqueio na hora.
- **Assinatura do profissional**: vale até a data definida pelo admin (ex.: dia 25) e mais 1 dia sem avisar (26); no dia seguinte (27) a conta é bloqueada sozinha com a tela "Perfil bloqueado" e o botão **"Renovar assinatura"** (WhatsApp). 2 dias antes do vencimento (23) aparece o aviso "Sua assinatura está acabando — o plano finaliza em 25/…" com o botão **Renovar**. Paciente não tem prazo.

## Versões

| Versão | Commit | O que tem |
|---|---|---|
| **1.1** | `81011a7` | Vitrine, chat com áudio, atendimento por vídeo, painel do admin |
| **1.2** | (esta) | Tudo da 1.1 + **Início estilo Instagram** |

### Versão 1.2 — Início estilo Instagram (só para quem tem conta)
- Navegação só com símbolos: 🏠 Início, 👤 Profissionais, 💬 Mensagens, ⚙️ Configurações (o profissional tem também 🎥 Atendimento e o próprio perfil). A barra é flutuante, arredondada e meio transparente (efeito vidro), com o botão ativo destacado; encolhe quando a pessoa rola para baixo e volta ao subir. No computador é a mesma barra, um pouco maior.
- **Início**: stories no topo e o feed de quem a pessoa segue. As publicações que ela ainda não viu aparecem primeiro (a mais nova no topo); depois vêm as já vistas **em ordem aleatória, que muda cada vez que o feed é aberto** (assim não aparece sempre o mesmo post primeiro). Enquanto a pessoa rola a mesma lista, a mistura fica fixa, sem repetir nem pular publicações.
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
- **Sugestões no feed**: de vez em quando, em posições aleatórias (0 a 1 a cada 12 publicações enquanto há novidades; 2 a 4 quando a pessoa já viu tudo, para o feed continuar movimentado; nunca antes das novidades) aparecem publicações de profissionais que a pessoa **não segue**, com o botão **Seguir** em cima da foto, ao lado do nome. Dá para curtir, comentar e compartilhar sem seguir. Quando acabam as publicações de quem ela segue (ou se ela não segue ninguém), o feed continua só com sugestões. Uma sugestão não se repete na mesma rolagem.
- **Publicação de texto** (profissional pela cruz + → "Publicar texto"; Acolia Brasil pelo admin → "Novo texto"): sem foto, até **3.000 caracteres** (contador embaixo do campo), com **4 fontes** (Padrão, Clássica, Manuscrita, Destaque — arquivos em `public/fonts`, licença livre OFL). No feed aparece num cartão com as primeiras linhas e **Ler mais**; no perfil fica junto das fotos, na aba **Publicações** (não existe aba só de textos; a aba especial é a de Vídeos/Reels). Não vai para o story.
- **Legendas até 1.700 caracteres** (fotos e vídeos, com contador); no feed a foto mostra 4 linhas e o vídeo 2, com **Ler mais** para abrir o texto inteiro junto da imagem/vídeo.
- **Reels** (profissional: vídeos de até **1 min e 30 s**; Acolia Brasil pelo admin: até **2 minutos**; sem limite de tamanho do arquivo; o envio vai em partes de 4 MB com barra de progresso e tenta de novo se a internet falhar): o profissional publica pela cruz (+) → "Publicar reel" (o aparelho tira a capa e mostra o progresso do envio). Os vídeos aparecem no feed junto com as fotos (tocam sozinhos sem som; tocar liga o som) e na aba **Reels** do Início (no topo: "Reels" = de todo mundo, aleatório; "Seguindo" = só de quem a pessoa segue, com as fotinhos; tocar na aba aberta atualiza; no fim aparece "Você assistiu todos os reels") — tela cheia, um por vez, arrastando para cima, em ordem aleatória, de todos os profissionais. Curtir (símbolo da Acolia), comentar, compartilhar, Seguir e **Mensagem** (o paciente fala direto com o profissional para marcar a consulta). O dono tem ⭐+ (colocar no story) e ⋮ (apagar). Obs.: vídeos gravados no iPhone em HEVC podem não tocar em alguns Android; MP4 (H.264) funciona em todos.
- **Formatos das fotos** (todas com 1080 px de largura): **Retrato 4:5** — 1080 × 1350 (recomendado, ocupa mais a tela) · **Quadrado 1:1** — 1080 × 1080 · **Paisagem 1,91:1** — 1080 × 566. Ao publicar, a 1ª foto escolhe o formato automático (dá para trocar); todas as fotos da publicação saem no mesmo formato. Foto de outro tamanho é recortada sozinha pelo centro e dá para arrastar e dar zoom para ajustar. Foto pequena demais não é esticada: fica no meio (até 2×) com faixas pretas. Reels: ideal em pé, 1080 × 1920 (9:16). As fotos publicadas antes disso foram medidas pelo sistema e aparecem recortadas pelo centro no formato mais próximo (o arquivo original não muda).
- **Envio em segundo plano**: ao tocar em Publicar (fotos, reel ou story) a janela fecha na hora e uma barrinha no topo mostra o progresso; dá para continuar usando o app. Sem internet ou com o app no fundo, o envio pausa e continua sozinho ao voltar. O vídeo do reel vai em pedaços e fica guardado no aparelho: mesmo fechando a aba, ao abrir o painel de novo ele continua de onde parou. No fim aparece "Publicado! **Ver**".
- **Limite de publicações por profissional** (começa com **15 publicações de fotos** e **10 vídeos**; o admin muda em Visão geral → "Limite de publicações por profissional"): ao publicar além do limite, a mais antiga é apagada sozinha (com os arquivos) para a nova entrar. Se o admin diminuir o limite, ele vê quantas vão sair e o excesso é apagado na hora. Uma publicação com várias fotos (carrossel) conta como 1. Stories não contam (somem em 24 h) e a Acolia Brasil não tem limite. Na hora de publicar o profissional vê "Você tem X de Y".
- **Botão Mensagem** nas publicações (feed e Reels; só para paciente — profissional não manda mensagem para profissional): a conversa abre com **aquela publicação anexada** em cima da caixa de texto (dá para tirar no ✕). Ao enviar, a publicação vai como um cartão (foto/capa do vídeo ou começo do texto, nome de quem publicou e "Ver publicação") junto com a mensagem, se houver. Regras no servidor: só o paciente envia publicação, e só uma publicação do próprio profissional da conversa (post de outro profissional é recusado). Se a publicação for apagada depois, o cartão vira "Publicação indisponível".
- **Perfil com abas**: 🔲 fotos e 🎬 vídeos, 4 de cada. "Ver todas as fotos" / "Ver todos os vídeos" abre a página de publicações, também com as duas abas.
- **Perfil oficial Acolia Brasil** (`site.com/acolia`): quem publica é a administração, em **/admin → ⚙️ Acolia Brasil** (fotos de 1 a 10 por publicação, Instagram da Acolia, curtidas, comentários — dá para apagar comentários e publicações). Todo mundo que tem conta segue automaticamente e **não consegue deixar de seguir**; a Acolia Brasil também segue todos os profissionais (cada um já começa com 1 seguidor e seguindo 1). As publicações aparecem no feed de todos. O perfil mostra só o nome, o Instagram, **seguidores pacientes** e **seguidores profissionais** (contam só contas ativas: paciente bloqueado/excluído e profissional com a licença vencida saem da contagem; contas de teste não contam) e todas as publicações com rolagem sem fim — sem consulta, valores nem mensagem. Visitante sem conta tem o mesmo bloqueio dos outros perfis. A administração não vê o feed nem segue ninguém.

### Voltar para a versão 1.1
O banco só **ganhou** tabelas novas na 1.2 — nenhuma conta, mensagem ou dado da 1.1 foi alterado. Por isso dá para voltar e depois vir de novo sem perder nada (na 1.1 as publicações e stories só ficam guardados, sem aparecer).
1. No Render, abra o serviço **acolia** → **Events** (ou **Deploys**).
2. Ache o deploy do commit **`81011a7`** ("Vitrine do paciente: filtro automático aparece no botão Filtrar").
3. Clique em **Rollback** e confirme. Em alguns minutos o site volta para a 1.1.
4. Para voltar para a 1.2, faça o mesmo com o deploy mais recente (ou clique em **Manual Deploy → Deploy latest commit**).
