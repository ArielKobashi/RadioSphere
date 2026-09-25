# 🌐 WORLD RADIO GLOBE — Central de Comunicações 3D

Uma aplicação web interativa em ambiente **GIS 3D** desenvolvida com **CesiumJS**, permitindo explorar o planeta Terra em modelo geográfico real **WGS84** e sintonizar estações de rádio ao vivo em qualquer continente. A interface combina mapa orbital imersivo e controles compactos, com foco na descoberta e na reprodução das rádios.

---

## 🎨 Paleta de Cores e Identidade Visual

- **Fundo Base:** `#05070D` (Espaço profundo com vinheta radial)
- **Painéis e HUD:** carvão translúcido com blur moderado
- **Bordas & Divisores:** cinza-azulado discreto
- **Destaques & Acentos:** `#5BD8E8` (ciano suave reservado a foco e ação)
- **Texto Principal:** `#F1F7FA`
- **Status Operacional:** `#10B981` (Online), `#F59E0B` (Carregando), `#F43F5E` (Alerta/Erro)

---

## 🏗️ Arquitetura do Projeto

O código está estruturado em módulos desacoplados para facilidade de manutenção e escalabilidade:

```text
world-radio-globe/
├── index.html          # Casca semântica, HUDs, containers e modais
├── css/
│   ├── style.css       # Design System, variáveis CSS, temas e componentes
│   ├── globe.css       # Estilos específicos do canvas CesiumJS e marcadores
│   ├── player.css      # Barra inferior de áudio e painel de informações
│   ├── responsive.css  # Layout para tablet e telas móveis
│   └── visual.css      # Acabamento visual e ajustes responsivos finais
├── js/
│   ├── app.js          # Orquestrador principal da aplicação e eventos da UI
│   ├── config.js       # Limites e tempos de cache/requisição
│   ├── globe.js        # Gerenciador do CesiumJS (WGS84, iluminação, câmera e telemetria)
│   ├── utils.js        # Utilitários (Haversine, formatação de telemetria, storage, toasts)
│   ├── radioApi.js     # Cliente Radio Browser, normalização e geocodificação
│   ├── search.js       # Busca remota e busca local no catálogo completo
│   ├── player.js       # Player HTMLAudio, volume e estados de reprodução
│   ├── audioVisualizer.js # Analisador WebAudio sem sinal simulado
│   └── metadataManager.js # ICY, endpoints de rádio e interface de reconhecimento
└── README.md           # Documentação técnica e guia de execução
```

## 🎧 Exploração, biblioteca e filtros

- O cartão inicial oferece busca, estação aleatória e World Tour sem cobrir o globo com um modal.
- A biblioteca local reúne favoritos e as últimas 50 rádios reproduzidas. Os dados ficam no navegador atual.
- País, cidade/região, idioma, gênero, codec e bitrate filtram os marcadores já carregados. Ao explorar outras regiões, as novas estações continuam respeitando os filtros ativos.
- O painel da estação oferece um botão de escuta; o player fixo mostra o estado, a estação e sua localização.
- O botão de filtro por distância não está disponível porque a aplicação não solicita localização do dispositivo.
- O catálogo global carrega em segundo plano por páginas de até 1.000 rádios, limita concorrência a duas requisições e salva páginas em IndexedDB por 24 horas quando o navegador permite.
- “Todas as estações” abre uma lista paginada de até 50 itens por página. O catálogo inclui emissoras sem coordenadas; esses resultados também aparecem na busca, sem receber localizações inventadas.
- O painel de cobertura separa registros válidos, geolocalizados, sem coordenadas e estados de verificação conhecidos. Cidades só são contadas se vierem no campo da fonte; as regiões são aproximações geográficas.
- “DEBUG RADIO” informa metadados do diretório e estado de reprodução. O navegador não expõe o status HTTP nem a latência do elemento HTMLAudio, então esses campos são indicados como não medidos.

---

## 🔑 Como Obter e Configurar o Cesium Ion Access Token

O **CesiumJS** oferece camadas globais de alta resolução (Cesium World Imagery / Bing Maps), relevo 3D e edifícios fotogramétricos através da plataforma **Cesium Ion**.

### Passo a Passo para Gerar a Chave Gratuita:
1. Acesse o portal oficial: [https://ion.cesium.com/signup](https://ion.cesium.com/signup).
2. Crie uma conta gratuita (Community / Individual tier).
3. Após o login, acesse a aba **"Access Tokens"** no menu superior.
4. Você verá um `Default token` já criado ou poderá criar um novo clicando em **"Create Token"**.
5. Copie o token gerado (uma longa sequência alfanumérica iniciando com `eyJ...`).

### Como Ativar na Aplicação:
1. Abra a aplicação no navegador.
2. Na barra de ferramentas lateral esquerda do globo, clique no ícone de chave (**"Token Cesium"**).
3. Cole o token no campo de texto e clique em **"Salvar Token & Recarregar"**.
4. O token ficará salvo no `localStorage` deste navegador. Não use tokens privados em computadores compartilhados.

> 💡 **Sem token:** o mapa padrão usa a camada Dark Gray do Esri e não requer Cesium Ion. Também há opções Satélite Esri e OpenStreetMap; consulte os créditos e termos das camadas antes de publicar.

---

## 🚀 Como Executar o Projeto Localmente

O CesiumJS utiliza **Web Workers**, compiladores de shaders WebGL e requisições assíncronas para texturas, exigindo a execução sobre o protocolo HTTP/HTTPS (o carregamento direto via `file:///` é bloqueado pelas políticas de segurança dos navegadores).

### Opção recomendada: servidor Node.js
O recurso de identificação de música por metadata usa o servidor local incluído. No terminal, dentro da pasta do projeto, execute:
```bash
node server.js
```
Em seguida, abra seu navegador em: `http://localhost:8765`.

### Servidor estático (sem identificação por metadata)
Também é possível usar Python ou outro servidor estático para explorar o globo, mas os recursos `/api/nowplaying` e de identificação do áudio só existem no `server.js`.
```bash
python -m http.server 8080
```

---

## 🇧🇷 Brasil em primeiro lugar

Na abertura, a aplicação percorre todas as páginas brasileiras do Radio Browser até a página curta (com um limite defensivo de 1.000 páginas), mostra no globo as estações que têm coordenadas e guarda as brasileiras à frente das estações descobertas depois. Registros brasileiros sem coordenadas continuam na busca/lista, mas não podem virar pins em uma posição inventada.

No painel **Filtrar estações**, a lista de países vem do diretório global. Aplicar um país consulta e carrega as páginas daquele país antes de filtrar no mapa. Quando uma transmissão falha, o player também procura outro URL cadastrado para a mesma rádio e região; se a emissora estiver fora do ar ou todos os links estiverem antigos, informa isso em vez de marcar uma falsa reprodução.

O botão **Consultar e validar o catálogo Dials do Brasil** navega por estado e cidade no [Tudo Rádio](https://tudoradio.com/dials). Também é possível importar o catálogo nacional inteiro em segundo plano, com cancelamento. Os registros verificados entram na busca e na biblioteca; rádios sem coordenadas ficam disponíveis em lista, sem pinos inventados.

Para cada rádio Dials, o app primeiro confirma o cadastro/frequência, tenta validar o endereço de áudio publicado pelo próprio Dials e só então procura uma alternativa no Radio Browser. O teste faz uma requisição curta e exige resposta de áudio; URLs rejeitadas ficam fora do player. Ao falhar, a página oficial de escuta da emissora no Tudo Rádio continua disponível no painel.

## 🎵 Identificação de música

O botão **IDENTIFICAR MÚSICA** tenta primeiro ler a faixa que a própria rádio publica em seus metadados ICY/Icecast/AzuraCast, sem chave ou FFmpeg. Se a emissora não publicar a faixa, existe um fallback acústico opcional via `songs/v3/detect` do RapidAPI; esse fallback precisa de chave e FFmpeg para converter 4 segundos do stream para PCM mono 44.1 kHz. A chave nunca fica no JavaScript do navegador.

Para ativar:

1. Execute `node server.js` na pasta do projeto e acesse `http://localhost:8765`; metadata das estações funciona sem conta.
2. Para ativar também o reconhecimento acústico quando a estação não informa a música, instale FFmpeg e configure `FFMPEG_PATH`.
3. Obtenha a chave do serviço no [RapidAPI](https://rapidapi.com/apidojo/api/shazam), copie `.env.example` para `.env` e preencha `RAPIDAPI_KEY`.

O app nunca inventa uma faixa: rádios sem metadata só podem ser reconhecidas acusticamente quando a chave e o FFmpeg estiverem configurados. O fallback envia um trecho curto da estação escolhida ao serviço de reconhecimento e depende da disponibilidade e dos limites do RapidAPI.

## 🔒 Segurança, CORS e Políticas de Áudio dos Navegadores

1. **Mixed Content (HTTP x HTTPS):**
   - Ao executar a aplicação em um ambiente HTTPS em produção, os navegadores modernos bloqueiam transmissões de áudio que utilizam URLs puras `http://` (Mixed Active Content).
   - Os resultados HTTPS aparecem priorizados. O navegador pode bloquear transmissões HTTP dentro de uma página HTTPS.
   - Se for necessário escutar uma rádio que só transmite em HTTP, é possível executar um proxy reverso simples (como Nginx, Cloudflare Workers ou serviço CORS proxy).

2. **Políticas de Autoplay:**
   - Selecionar uma estação prepara os controles; o áudio só começa depois do clique explícito no botão de reprodução.

---

## 📻 Integração com a Radio Browser API (Fase 2)

O módulo `radioApi.js` consulta a lista documentada de mirrors da Radio Browser, tenta alternativas quando uma falha, usa cache curto em memória e normaliza resultados. A busca textual também consulta sob demanda o catálogo IPRD de rádios públicas e comunitárias; essas entradas são identificadas e podem tocar sem aparecer como pinos porque o catálogo não oferece coordenadas. A amostra IPRD pode estar desatualizada. HTTPS é priorizado, mas não garante que uma transmissão funcione.

A busca de lugares consulta Nominatim somente após envio explícito e mantém cache local. Não há autocomplete: a política do serviço público proíbe esse padrão. O painel identifica quando uma transmissão não está cadastrada.

---

## 📡 Renderização de Marcadores, Clustering e Efeito 3D (Fase 3)

O sistema de renderização GIS foi equipado com gráficos procedurais de alta fidelidade:
- **Pins Holográficos Procedurais (Canvas HiDPI):** Marcadores gerados em runtime via Canvas 2D com gradientes radiais em `#5BD8E8`, anéis de radiofrequência e núcleo branco de alta intensidade.
- **Clustering Nativo do CesiumJS:**
  - `pixelRange: 48` e `minimumClusterSize: 3`.
  - Agrupamentos são representados por discos de radar futuristas com contagem centralizada de estações (`[ 24 ]`) e retículos cibernéticos.
  - Ao clicar em um cluster, a câmera realiza um zoom aproximado suave (*flyTo* 2.5x) para desmembrar o grupo em estações individuais.
  - O botão **Agrupar estações** no HUD desliga o agrupamento e mostra os pins individuais já carregados; a preferência fica salva neste navegador.
- **Animação 3D de Ondas de Radiofrequência:** Quando uma estação é sintonizada, uma elipse dinâmica (`Cesium.CallbackProperty`) pulsa e propaga ondas concêntricas diretamente sobre a curvatura do relevo WGS84, simulando a transmissão eletromagnética da antena emissora.
- **Tooltips Flutuantes no Hover:** Detecta mouse sobre estações ou hubs, exibindo em tempo real Nome, Localidade, Tags e Código do sinal com estilo glassmorphism.
- **Radar de Varredura por Viewport:** Ao aproximar o zoom, o sistema monitora `camera.moveEnd` com debounce, consulta até quatro páginas de mil registros aleatórios e filtra a área no cliente. A quantidade visível aumenta em níveis próximos e o limite de memória do mapa é 5.000 estações. A API não documenta filtro espacial; veja [AUDITORIA.md](AUDITORIA.md).
- **Zoom próximo:** Controles +/− e roda do mouse aproximam a câmera até 80 m; o nível de detalhe final depende das imagens disponíveis em cada provedor.
- **Pins e transmissão:** Pins vetoriais HiDPI exibem aro ativo pulsante, ondas menores na superfície e agrupamentos; o clustering pode ser desligado. O visualizador só reage quando o stream permite análise WebAudio; sem CORS, explica a indisponibilidade.

---

## 🎵 Player de áudio & Efeito 4D Temporal (Fase 4)

- **Correção e Arquitetura de Basemaps (Fim do "Globo Azul"):**
  - No CesiumJS 1.119+, a propriedade antiga `imageryProvider` foi descontinuada na criação do Viewer. A ausência de `baseLayer: false` forçava o Cesium a buscar o asset padrão da Cesium Ion, gerando erro 401 e deixando o globo sem textura (apenas o elipsoide azul padrão).
  - Desativamos a camada Ion implícita e adicionamos seletor direto de mapa, com preferência salva:
    1. **Escuro:** Esri Dark Gray com referências.
    2. **Ruas:** Esri World Street Map.
    3. **Satélite:** Esri World Imagery.
    4. **OpenStreetMap:** Cartografia aberta com créditos dos contribuidores.
- **Player de Áudio (`player.js`):**
  - Reprodução de streams HTTP/HTTPS compatíveis com o navegador.
  - Indicadores de estado da transmissão: `CONECTANDO...`, `BUFFERING`, `AO VIVO` e `STREAM INDISPONÍVEL`.
  - Tratamento para erro de Mixed Content (quando sites seguros bloqueiam fluxos HTTP não criptografados).
  - Controle de Volume com memória local (`localStorage`) e atalho para Mute/Unmute.
  - Tecla de atalho global `Espaço` para Play/Pausa instantâneo.
- **Efeito 4D Temporal (Ciclo Solar Acelerado):**
  - Integração com o relógio de simulação do CesiumJS (`viewer.clock`).
  - Velocidades de aceleração: `1x`, `10x`, `100x` e `1000x`.
  - Saltos de tempo de `+3 horas` e `-3 horas` para avançar do dia para a noite.
  - Botão de sincronização em tempo real com a hora da máquina.
  - Em velocidade `1000x`, o usuário pode assistir ao terminador solar (linha de sombra da noite) cruzar os oceanos e continentes em tempo real!

---

## 🗺️ Estado do projeto

- [x] **FASE 1 (Entregue):** Esqueleto do projeto, HUD com relógios UTC/Local, controles de navegação, integração completa do CesiumJS (WGS84, atmosfera, iluminação solar dinâmica dia/noite, telemetria em tempo real, suporte ao Ion Token e Dark Fallback).
- [x] **FASE 2 (Entregue):** Integração com Radio Browser API (descoberta de mirrors, consultas limitadas, proximidade Haversine, priorização HTTPS, painel de estação, favoritos e geocodificação Nominatim).
- [x] **FASE 3 (Entregue):** Sistema de Renderização de Marcadores e Clustering com billboards sci-fi, animações 3D de ondas sobre o globo, radar de varredura por viewport e tooltips holográficos em tempo real.
- [x] **FASE 4 (Entregue):** Camadas de mapa (Dark Canvas, Satélite e OSM), player HTMLAudio com volume e estado de reprodução, e Efeito 4D (relógio de simulação com aceleração 1x-1000x da iluminação solar).
- [x] **Busca por envio:** Pesquisa de estações e lugares, buscas recentes, abertura contextual do painel e voo da câmera. O autocomplete não é usado no Nominatim público, de acordo com a política do serviço.
- [x] **Catálogo paginado:** cache local IndexedDB, carregamento global em segundo plano, busca local e lista com até 50 itens por página.
- [x] **Diagnóstico de rádio:** cobertura aproximada, contagem dos registros carregados e painel DEBUG RADIO sem afirmar HTTP/CORS/latência que o navegador não revelou.
- [ ] **Limites externos:** reconhecimento musical real requer um serviço/backend configurado; testes visuais em dispositivos continuam necessários antes de publicar.

Consulte [AUDITORIA.md](AUDITORIA.md) e [DATA_SOURCES.md](DATA_SOURCES.md) para cobertura, termos das fontes e limitações.

### Testes locais

Com Node.js instalado, execute `node tests/radio-core.test.cjs` para verificar normalização, paginação/cache do catálogo, deduplicação, busca sem coordenadas, cobertura, estados do player e fallback honesto de metadata/visualizador.

### Publicação no GitHub Pages

O GitHub Pages publica arquivos estáticos e não executa `server.js`. Para incluir o Tudo Rádio Dials no site publicado, gere e envie junto os dados JSON do catálogo:

```powershell
node scripts/build-tudoradio-static.js
```

O gerador consulta os índices das 27 UFs e grava o índice em `data/tudoradio/index.json`, além de um arquivo por cidade em `data/tudoradio/cities/`. Revise e faça commit da pasta `data/tudoradio/` antes de publicar. A página usa automaticamente a API local quando servida por `node server.js` e os arquivos estáticos no GitHub Pages. Se os dados estáticos não estiverem presentes, a interface informa o que falta sem disparar 27 chamadas que inevitavelmente falhariam.

O catálogo público é uma fotografia da data em `generatedAt`; gere novamente antes de publicar atualizações. A validação remota de streams também requer o servidor Node; em GitHub Pages, cada estação continua listada e o link do Tudo Rádio permanece disponível.

Quando o catálogo nacional Dials é importado, o navegador grava as respostas por cidade no IndexedDB e restaura registros e posições de cidade nas próximas visitas, sem baixar tudo novamente. Como o Dials não publica coordenadas de cada transmissor, o mapa mostra um pin aproximado por cidade, usando coordenadas conhecidas do Radio Browser ou geocodificação do OpenStreetMap. Os pins de cidade abrem as estações Dials daquela cidade. O globo limita a camada a 5.000 pins para reduzir travamentos e perda visual em celulares.
