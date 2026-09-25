# Auditoria do WORLD RADIO GLOBE

## Diagnóstico inicial

### Arquitetura atual

- `index.html`: estrutura da HUD, busca, controles do Cesium, painel de estação, player e modal de token.
- `css/style.css`, `globe.css` e `player.css`: tema espacial, controles, globo, painel e player.
- `js/app.js`: inicialização, integração entre módulos, eventos, favoritos, descoberta aleatória e World Tour.
- `js/globe.js`: CesiumJS/WGS84, camadas base, relógio simulado, marcadores, clustering, tooltip e telemetria.
- `js/radioApi.js`: cliente Radio Browser, normalização, cache, geocodificação Nominatim e consultas geográficas.
- `js/player.js`: reprodução HTMLAudioElement, volume, mute e estados.
- `js/utils.js`: armazenamento local, toast, debounce, formatação e distância.

### Tecnologias e fontes atuais

JavaScript sem framework, CesiumJS 1.119 carregado por CDN, Radio Browser API e catálogo IPRD como fontes de estações, Nominatim público para busca explícita de lugares e camadas base Esri/OpenStreetMap. CARTO foi retirado das camadas ativas porque os termos vigentes exigem chave para esse serviço.

### Carregamento e cobertura antes das mudanças

A tela inicial pedia 80 estações ordenadas por votos. A chamada de viewport carregava as 100 primeiras do mesmo ranking global e só então filtrava pela caixa visível; portanto, um movimento para uma região pouco popular podia retornar zero estações mesmo havendo registros locais. A lista acumulada podia crescer sem limite efetivo: a rotina removia apenas 50 itens uma única vez. O normalizador descartava estações sem URL de stream, e o filtro geográfico descartava as que não tinham coordenadas.

### Problemas de UX e visual

- A barra de busca não tinha ação conectada e o módulo `search.js` era apenas um esqueleto.
- A seleção do marcador iniciava áudio imediatamente, sem passar pelo botão Play.
- Não havia layout responsivo para celular/tablet, apesar da HUD e do player usarem posições fixas de desktop.
- Controles removiam o contorno de foco, reduzindo a clareza na navegação por teclado.
- Nominatim estava descrito/posicionado como parte de uma busca automática; sua política não permite autocomplete no serviço público.
- O cartão da estação não destacava uma ação principal de escuta, embora o player inferior existisse.
- A tela sem seleção não oferecia uma orientação curta sobre como começar; a identidade visual usava brilho e texto técnico demais para uma experiência de exploração.

### Segurança, desempenho e limitações dos dados

- Campos de estação eram interpolados em `innerHTML`, incluindo nome, tags e URLs. Dados de catálogo devem ser considerados não confiáveis.
- O cliente tentava definir `User-Agent`, cabeçalho que navegadores não permitem que páginas web controlem.
- Timeout da consulta podia ficar ativo após falhas.
- A busca geográfica depende do catálogo: a API documentada não expõe filtro por caixa geográfica nem campo de cidade. A aproximação implementada usa amostra mundial ou estações de um país e filtra coordenadas no cliente; cobertura local não é garantida.
- Um stream cadastrado ou com última checagem positiva não garante que tocará agora. CORS, Mixed Content, codecs e indisponibilidade temporária continuam sendo limitações do browser e dos provedores.
- Estatísticas globais não estavam disponíveis na UI. Não foram adicionados totais inventados.

## Alterações desta rodada

- Busca por envio, com resultados de estações e lugares, buscas recentes locais e tratamento de falha. O geocodificador é consultado somente após envio explícito, com cache e intervalo mínimo entre chamadas.
- Carga inicial ampliada e amostragem geográfica corrigida para não usar sempre o top 100 global. Limite de memória de marcadores centralizado.
- Resultados podem incluir estações sem coordenadas ou sem stream; o painel identifica a limitação e o player fica indisponível quando não há stream.
- Selecionar uma estação abre o painel e prepara o player; a reprodução começa pelo botão Play.
- URLs externas limitadas a HTTP/HTTPS sem credenciais e conteúdo de texto da estação escapado antes de renderizar HTML.
- Ajustes de foco acessível, pesquisa flutuante, responsividade para telas estreitas e suporte a `prefers-reduced-motion`.
- Configurações compartilhadas de limites e tempos em `js/config.js`.
- Refinamento visual em `css/visual.css`: paleta ciano mais contida, painéis com menos brilho, raio e espaçamento consistentes, controles mais fáceis de tocar e ajustes para telas pequenas.
- Convite inicial não modal com caminhos funcionais para busca, descoberta aleatória e World Tour; fecha ao começar a explorar e guarda a preferência localmente.
- Cartão de estação mais claro, com informações agrupadas e botão principal “Ouvir esta rádio”; o player inferior identifica cidade/país e anuncia mudanças de estado.
- Biblioteca funcional de favoritos e histórico local de reprodução, com seleção e play a partir da lista.
- Filtros reais para país, cidade/região, idioma, gênero, codec e bitrate entre as estações já carregadas; novos lotes respeitam os filtros ativos.

## Auditoria visual solicitada

### Diagnóstico visual e de UX

- O globo já ocupava a tela inteira e as funções GIS/rádio existiam, mas a HUD lembrava um protótipo técnico: muitos contornos e ciano, títulos em caixa alta e uma estação sem chamada de ação principal.
- O fluxo agora começa com orientação curta, permite buscar ou descobrir, seleciona a estação e mantém o botão de escuta disponível no painel e no player fixo.
- Busca, varredura, erro de stream e carregamento têm estados distintos; o movimento decorativo respeita a preferência de movimento reduzido.

### Direção visual, UI e design system

- Mantida a identidade espacial, agora com superfícies carvão/cinza-azul, ciano `#5BD8E8` limitado a foco e ação, blur moderado e menos glow.
- Criado o cartão inicial “O mundo está no ar.”; o painel da estação ganhou hierarquia de mídia e CTA de reprodução; o player tem maior área de toque e estado acessível.
- As regras para desktop, tablet e celular permanecem separadas, com ajustes finais em `css/visual.css`; busca, painéis e player continuam compactos ao reduzir a largura.

### Acessibilidade e animação

- Foco de teclado visível, nomes/descrições em controles, resultados de busca como lista de opções e estado de reprodução anunciado por região `status`.
- Transições de interface curtas; animação de identidade e entrada do cartão são desligadas para `prefers-reduced-motion`.

### Funcionalidades preservadas e limites

- Busca explícita, seleção sem autoplay, reprodução, volume/mute, favoritos por estação, mapas base, iluminação dia/noite, horário simulado, globo interativo, descoberta aleatória e World Tour permanecem ligados aos dados e controles reais existentes.
- Os filtros atuam sobre estações já carregadas e não incluem raio/distância; a busca de distância requer geolocalização autorizada. World Tour continua com alternância de início/parada, sem controles independentes de próxima etapa nem modo cinema.

### Verificação visual e próximos passos

- A aplicação foi aberta no navegador local e a árvore acessível confirmou os elementos da primeira visita, busca, controles, player e modal de configuração.
- Não consegui obter neste ambiente capturas confiáveis para comparar 1920×1080, 1366×768, tablet e celular após o último refinamento. As regras responsivas estão implementadas, mas esses tamanhos devem ser conferidos visualmente antes de publicar.
- Para evoluir: acrescentar filtro por distância com fluxo de localização claro, controles de destino/mode cinema para World Tour e conferir a interface em cada viewport; substituir a geobusca aproximada por fonte com consulta espacial.

## Recomendações futuras

### Críticas

- Para precisão e cobertura completa da busca geográfica, adicionar um backend ou provedor que tenha filtros espaciais documentados. A varredura paginada melhora a amostragem, mas Radio Browser não oferece consulta por bounding box/cidade.
- Considerar proxy/backend próprio para atribuir User-Agent de aplicação, trocar o geocodificador sem atualização do frontend e controlar CORS, rate limits e cache compartilhado.

### Importantes

- Ampliar a suíte automatizada com casos de timeout, limite de cache, estados de busca e interação responsiva da interface.
- Expandir favoritos e histórico com sincronização entre dispositivos e métricas de catálogo servidas por fonte oficial.
- Reavaliar CesiumJS e fontes de tiles, termos de uso e limites antes de publicar para público amplo.

### Opcionais

- World Tour pausável com controles de destino, timezone local e modo cinema.
- Agrupamento geográfico do catálogo em níveis de país/cidade, apoiado por fonte licenciada para geocodificação em escala.

## Verificação responsiva anterior ao refinamento visual

Na rodada anterior, a aplicação foi conferida em 639×560: busca, painel, player e controles ficaram dentro da janela, sem rolagem horizontal. O último refinamento foi aberto no navegador local e sua árvore acessível foi conferida; não foi possível obter capturas confiáveis em 1920×1080, 1366×768, tablet e celular para validar visualmente cada composição.

## Refinamento mais recente: cobertura, mapa, pins e player

- A varredura regional percorre até quatro páginas paginadas (até 4.000 registros) do Radio Browser antes de filtrar as coordenadas; o carregamento inicial foi ampliado para até 4.000 estações, e o limite de estações mantidas no mapa é 5.000.
- A busca textual consulta também o IPRD. Esse catálogo não traz coordenadas e a amostra documentada está desatualizada; os resultados são identificados e podem tocar sem aparecer no globo. Alguns links podem falhar.
- O seletor oferece mapa escuro, ruas, satélite e OSM, e salva a escolha. Zoom por botões permite chegar a 80 m; o detalhe real depende da camada cartográfica escolhida.
- Pins HiDPI têm aro e haste vetorial, a estação ativa pulsa, as ondas de rádio ficam mais rápidas e compactas, e o player reage ao estado ao vivo com brilho e sete barras animadas.
- O agrupamento de pins pode ser ativado ou desativado pelo novo controle no HUD; a escolha persiste no navegador. Desativado, cada estação carregada aparece individualmente no mapa.
- A cobertura continua limitada pelas coordenadas cadastradas e pela amostragem da API, que não tem filtro espacial documentado. Páginas extras aumentam o tráfego de rede ao explorar novas regiões.

## Auditoria final de funcionamento — 25/09/2026

### Alterações e verificações concluídas

- A abertura põe até quatro páginas de pins no globo e inicia a leitura paginada do catálogo total em segundo plano, com lotes de no máximo duas requisições simultâneas. IndexedDB guarda páginas por 24 horas e a pesquisa local inclui estações sem coordenadas. O contador do HUD separa pins, itens únicos já indexados e total oficial; quando a API falha, o total fica omitido.
- O player não força `crossOrigin="anonymous"`, que impedia alguns streams sem cabeçalho CORS de tocar. A sintonia começa sem atrasos artificiais, cada solicitação invalida a anterior e pausar/cancelar estação interrompe o temporizador de reconexão.
- A busca textual deixa de falhar se um cliente não oferecer o provedor IPRD. O filtro não geográfico inclui estações com e sem coordenadas; a deduplicação cruza UUID, URL, nome/localidade e nome/site.
- O visualizador não desenha curvas sintéticas como se viessem da música. O canvas só usa dados do `AnalyserNode` quando uma fonte habilita CORS para análise; nos outros casos indica claramente que o acesso ao sinal está indisponível e mantém o áudio nativo.
- Now Playing agora é ligado ao estado observado pela interface e informa busca, metadata encontrada, confiança possível ou faixa desconhecida. O fallback não grava “Transmissão ao vivo” como título de música. A biblioteca de reprodução guarda artista, álbum, fonte e confiança quando esses dados existem.
- “Todas as estações” exibe até 50 itens por página, incluindo rádios sem coordenadas; é possível pausar/retomar o carregamento. O painel de cobertura informa válidas, coordenadas, verificações online/offline/desconhecidas, países, cidades declaradas, idiomas, duplicatas e regiões aproximadas. DEBUG RADIO expõe o stream e os estados disponíveis e identifica explicitamente HTTP/latência/CORS não medidos pelo elemento de áudio.
- Os 21 testes passaram em execução sequencial no mesmo processo: normalização, cache, estatísticas, paginação, cancelamento, deduplicação, busca sem coordenadas, cobertura, player, reconexão, metadata e ausência de sinal simulado. O lançador padrão do Node foi bloqueado ao tentar criar processo filho neste ambiente; executar a suíte sequencialmente produziu 21 aprovados e 0 falhos. `node --check` passou nos scripts JavaScript editados.

### Estado dos requisitos

| Recurso | Estado | Evidência / limite atual |
| --- | --- | --- |
| Globo, rotação, zoom e mapas | Parcial | Cesium, troca de mapa e limites de zoom de 80 m a 45.000 km existem; validação visual final não foi possível neste turno. |
| Pins e clustering desligável | Implementado | Preferência salva no navegador; desligado, cada estação carregada é representada individualmente. |
| Busca multi-provider | Parcial | Radio Browser e IPRD são consultados; o IPRD não fornece coordenadas documentadas, e sua disponibilidade/atualidade depende do mantenedor. |
| Catálogo global | Parcial (implementado; execução real pendente) | Varre páginas até o total oficial, mantém no máximo 5.000 pins e entrega o catálogo inteiro à busca/lista local. Os endpoints do Radio Browser expiraram durante a verificação, então não confirmei a conclusão de uma varredura real. |
| Contagem global | Parcial | Lê `/json/stats` e separa itens indexados do total da fonte. A chamada real expirou neste ambiente; nenhum número global é publicado como medido nesta auditoria. |
| Player | Parcial | Busca, reprodução, pause, autoplay bloqueado, erros e retentativa têm tratamento. Nesta atualização, o endpoint do servidor validou o áudio Dials da Capital FM; reprodução no navegador e outros streams ainda variam por emissora. |
| Metadata / Now Playing | Parcial | Tenta ler ICY e endpoints JSON comuns; dependem de CORS e dos endpoints de cada rádio. Não foi possível confirmar uma faixa em stream real nesta execução. |
| Reconhecimento acústico | Não implementado como serviço | Há somente uma interface vazia de provedor. Reconhecimento real necessita serviço/backend externo e credencial protegida; não é anunciado como funcional. |
| Visualizador | Parcial | Sem CORS no áudio, mostra indisponibilidade em vez de animação enganosa. O analisador só funciona em streams que permitam leitura WebAudio; nenhum stream compatível foi validado aqui. |
| Cache do catálogo | Parcial (implementado; execução real pendente) | Páginas e estado completo usam IndexedDB com TTL de 24 horas, retomada de páginas e fallback stale; a persistência do navegador e a carga real ainda precisam ser confirmadas em execução visual. |
| Lista global / Debug Radio | Implementado no código | Lista paginada e painel diagnóstico foram adicionados, mas a interação visual real não pôde ser conferida neste turno. |
| Mobile e performance | Não verificado visualmente | As regras responsivas e o clustering estão no código, mas as larguras solicitadas (360×640, 375×667, 390×844, 412×915 e 768×1024), FPS e memória não foram medidas. A política do navegador desta sessão bloqueou a abertura do projeto local, então não afirmo aprovação visual. |
| PWA | Parcial | O service worker mantém o app shell; catálogo completo e streams não ficam disponíveis offline. |

### Números que não foram observados

Estações recebidas/válidas/offline/sem coordenadas/duplicadas, países, cidades, faixas com metadata e faixas identificadas não foram contados em um carregamento real do serviço durante esta auditoria. O código agora calcula as métricas sobre o catálogo paginado quando a fonte responder; “cidade” só conta campos de cidade presentes no registro, e regiões são caixas aproximadas. Nenhum desses campos deve ser preenchido com estimativas.

## Complemento — Shazam, Brasil e troca de mapas

- A inicialização agora percorre as páginas de `countrycode=BR` até a página curta ou o limite de segurança; inclui rádios sem coordenadas no catálogo, põe os pins brasileiros primeiro e os protege da limpeza de memória usada por descobertas posteriores. Somente registros geolocalizados podem aparecer no mapa.
- O painel da estação ganhou reconhecimento Shazam explícito sob demanda. O servidor Node captura quatro segundos, FFmpeg decodifica para PCM 44.1 kHz mono, e o servidor faz a chamada RapidAPI sem expor a chave ao navegador. Há limite de requisições e rejeição de URLs locais; `.env` fica excluído de versionamento e do servidor estático.
- Para ativar o reconhecimento, ainda é necessário instalar FFmpeg e preencher `RAPIDAPI_KEY` de uma conta do endpoint Shazam/RapidAPI. Essa chave e o executável não estavam disponíveis para teste end-to-end, então o reconhecimento não foi confirmado aqui.
- O seletor mantém as quatro camadas, força redesenho após trocar e persiste a seleção. Os tiles ainda dependem de acesso às fontes cartográficas; a camada visual não foi conferida no navegador nesta sessão.
- Verificação de código: 24 testes unitários passaram em execução sequencial, mais `node --check` dos JavaScripts, do servidor Node e dos testes.

## Complemento — reconhecimento sem chave e filtro global

- O botão agora consulta primeiro metadata ICY/StreamTitle e endpoints comuns de Icecast/AzuraCast por um endpoint same-origin do servidor Node. Isso identifica títulos que a estação realmente anuncia sem credencial; se não houver metadata, tenta o fallback acústico RapidAPI quando configurado.
- O seletor de país carrega `/json/countries`; ao aplicar um código, percorre as páginas daquele país e atualiza lista/busca/globo, em vez de filtrar somente a amostra local.
- Em falha final de reprodução, a aplicação procura primeiro outra entrada da mesma rádio/localidade e também tenta confirmar o stream publicado no Dials. O endereço de Capital FM que validamos vem do próprio catálogo, sem URL inventada.
- Verificação anterior: 27 testes unitários; consulte o complemento Dials abaixo para a validação mais recente.

## Complemento — Tudo Rádio Dials, validação e streams

- O app consulta as páginas estaduais para obter municípios e as páginas municipais para importar os registros Dials. Inclui a lista nacional de 27 UFs, importação completa opcional, controle de cancelamento e progresso, deduplicação por ID de emissora e cache temporário limitado. Registros sem coordenadas entram na biblioteca/busca, não como pinos inventados.
- Cada registro primeiro é confirmado como uma entrada Dials com nome, frequência e localidade. O endereço de áudio publicado passa por GET de faixa curta, seguindo redirecionamentos públicos e exigindo resposta HTTP e tipo/assinatura compatível com áudio. Somente depois de falha nessa URL o app procura rádios de mesmo nome e cidade no Radio Browser e testa seus streams.
- Se a execução normal do player falhar para uma estação brasileira, o app consulta o Dials da cidade/transmissor antes de desistir. A página oficial de escuta e a ficha técnica permanecem acessíveis no painel.
- Validação real em 25/09/2026: a página do PR listou 50 cidades Dials; Cascavel devolveu 80 registros. A URL publicada para Capital FM 102.7 respondeu HTTP 206, `audio/mpeg`, 512 bytes lidos, validada como áudio.
- Verificação de código atualizada: 29 testes unitários e `node --check` para servidor e scripts alterados. A importação nacional completa é sob demanda; ainda deve ser executada no navegador do usuário para baixar todas as cidades.
