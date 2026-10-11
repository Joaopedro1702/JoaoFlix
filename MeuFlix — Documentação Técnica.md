# MeuFlix — Documentação Técnica

Versão 1.2 · 08/10/2026 · Servidor Node.js/Express + FFmpeg + frontend em JavaScript puro

## 1. Visão geral

O MeuFlix é um servidor de streaming doméstico no estilo Netflix. Ele detecta automaticamente pendrives, HDs externos e pastas locais que contenham filmes e séries, monta uma biblioteca única e a entrega a um frontend web (navegador de PC, celular ou TV) com player, legendas, retomada de reprodução e navegação por controle remoto.

Princípios de projeto:

- **Zero configuração:** qualquer dispositivo com uma pasta Filmes ou Series na raiz entra sozinho, inclusive se for plugado com o servidor já em execução.
- **Menor trabalho possível por arquivo:** reproduzir direto quando o navegador suporta; copiar o vídeo (remux) quando só o contêiner ou o áudio é incompatível; recodificar apenas como último recurso.
- **Sem banco de dados:** a biblioteca é derivada do sistema de arquivos e o progresso fica no navegador.
- **Segurança por construção:** o cliente nunca envia caminhos de arquivo, apenas identificadores opacos validados pelo servidor.

## 2. Requisitos

| Item | Versão | Observação |
| --- | --- | --- |
| Node.js | 18 ou superior (usado na 22 e na 24) | Runtime do servidor |
| Express | ^4.19 | Única dependência npm |
| FFmpeg e FFprobe | Build recente | Necessários para MKV, áudio AC3/EAC3/DTS, HEVC, TV e cache. No Windows: winget install ffmpeg |
| Navegador | Chrome, Edge, Brave, Firefox, Safari; TVs Tizen, webOS e Android TV | A TV usa HLS via hls.js |
| Sistema | Windows, Linux ou macOS | A detecção de dispositivos varia por plataforma |

## 3. Instalação e execução

```
cd meuflix
npm install
node server.js
```

Abra http://localhost:3000. Na inicialização o servidor imprime os endereços da rede local (para TV e celular), os dispositivos detectados, a pasta de cache e o resultado da verificação do FFmpeg.

### 3.1 Configuração

| Variável / argumento | Padrão | Função |
| --- | --- | --- |
| PORT | 3000 | Porta HTTP |
| FFMPEG\_PATH | ffmpeg | Caminho do executável do FFmpeg |
| FFPROBE\_PATH | derivado de FFMPEG\_PATH | Caminho do ffprobe |
| MEDIA\_DIRS | vazio | Pastas extras, separadas por ; (Windows) ou : (Linux/macOS) |
| NO\_HW | vazio | Qualquer valor desativa a busca por encoder de hardware |
| Argumentos de linha de comando | nenhum | Pastas extras: node server.js "D:\\Midia" "E:\\" |

Sem argumentos e sem nenhum dispositivo detectado, o servidor usa ./media, criando as pastas Filmes e Series dentro dela.

## 4. Estrutura do projeto

```
meuflix/
├── server.js            Servidor, API, varredura, streaming e cache
├── package.json
├── public/
│   ├── index.html       Aplicação web (SPA)
│   └── hls.min.js       hls.js, usado nas TVs
├── media/               Pasta padrão opcional
└── .meuflix-cache/      Gerada: meta.json, MP4 em cache e segmentos HLS temporários
```

## 5. Organização da biblioteca

A raiz do dispositivo precisa conter uma pasta Filmes (ou Movies) e/ou Series (ou Séries, Shows). A comparação não diferencia maiúsculas de minúsculas.

```
E:/
├── Filmes/
│   ├── Matrix (1999).mp4
│   └── Interestelar/
│       ├── Interestelar.mkv
│       ├── Interestelar.srt
│       └── poster.jpg
└── Series/
    └── Dark/
        ├── Temporada 1/
        │   ├── Dark.S01E01.mkv
        │   └── Dark.S01E02.mkv
        └── Temporada 2/
```

- **Formatos:** .mp4, .m4v, .webm, .mkv, .mov.
- **Filmes:** arquivo solto ou pasta; no caso de pasta, vale o primeiro vídeo encontrado até um nível de profundidade.
- **Séries:** temporada reconhecida por «Temporada N», «Season N» ou «SNN». O episódio é rotulado «Episódio N» quando o nome contém SxxExx; caso contrário, usa o nome limpo do arquivo. A ordenação é natural, em pt-BR.
- **Capa:** arquivo com o mesmo nome do vídeo ou poster, folder, cover (jpg, jpeg, png, webp). Sem capa, o frontend gera um cartão colorido com o título.
- **Legendas:** arquivo .srt ou .vtt cujo nome começa com o do vídeo; é exposto como «Português».
- **Pendrives:** prefira exFAT ou NTFS, porque o FAT32 limita cada arquivo a 4 GB.

## 6. Arquitetura

```
Navegador / TV ──HTTP──▶ Express (server.js)
                         ├─ /api/library ─▶ detect() + scan()      (cache de 20 s)
                         ├─ /stream/:id  ─▶ plan() ─▶ direto | cache MP4 | remux (pipe) | recodificação
                         ├─ /api/hls     ─▶ ffmpeg ─▶ segmentos .ts + index.m3u8   (TV)
                         ├─ /img/:id, /sub/:id
                         └─ ffprobe (fila de 2) ◀▶ .meuflix-cache/meta.json
```

**Fluxo de reprodução**

1. O frontend carrega /api/library e desenha as linhas de cartões.
2. Ao tocar, escolhe o modo: direto (campo direct do episódio) ou ffmpeg. Na TV, antes consulta /api/meta?tv=1.
3. Modo direto: o elemento video aponta para /stream/id e o servidor responde com sendFile, que suporta Range.
4. Modo ffmpeg no desktop: /stream/id?t=segundo-inicial devolve MP4 fragmentado por pipe.
5. Modo ffmpeg na TV: /api/hls cria uma sessão HLS e devolve a URL da playlist.
6. A cada 5 s o progresso é gravado no localStorage do navegador.

## 7. Backend

### 7.1 Módulos

| Módulo | Funções principais | Responsabilidade |
| --- | --- | --- |
| Utilitários | enc, dec, clean, ls, natural, episodeNumber, seasonNumber | Codificação de IDs, normalização de nomes, leitura segura de diretórios |
| Metadados | runProbe, probe, metaFor, statKey | ffprobe em fila (2 simultâneos), cache em meta.json invalidado por tamanho e data de modificação |
| Planejamento | vSafe, plan | Decide faixa de áudio e se vídeo e áudio podem ser copiados ou enviados direto |
| Dispositivos | candidates, isLibrary, detect | Descobre as raízes de biblioteca |
| Varredura | scanRoot, scan, buildSeries, findPoster, subFile | Constrói filmes, séries, temporadas e episódios |
| Identificadores | makeRef, resolveId | Gera e valida IDs opacos |
| Streaming | sendMedia, baseArgs, inputOpts | Escolhe o modo e executa o ffmpeg |
| Cache MP4 | cachedMp4, startCache | Remux único em segundo plano (versão 1.2) |
| HLS | /api/hls, endHls | Sessões de segmentos para TV |
| Aceleração | probeHw, lowPriority | Encoder de hardware e prioridade baixa do ffmpeg |

### 7.2 Detecção de dispositivos

Um caminho vira biblioteca se tiver Filmes ou Series na raiz. Os candidatos variam por sistema:

- **Windows:** letras C: a Z:.
- **macOS:** subpastas de /Volumes.
- **Linux:** subpastas de /media, /run/media e /mnt, até dois níveis.

Cada raiz recebe uma chave de 8 caracteres hexadecimais (SHA-1 do caminho em minúsculas) e um rótulo: a letra da unidade (E:) ou o nome da pasta. A rota /api/library chama detect() a cada requisição que não esteja coberta pelo cache de 20 s, por isso um pendrive plugado ou removido aparece sozinho.

### 7.3 Identificadores e segurança

Todo arquivo é referenciado por um ID no formato chave-da-raiz.caminho-relativo-em-base64url. Em resolveId() o servidor confirma que a chave pertence a um dispositivo conhecido e que o caminho resolvido continua dentro da raiz, o que bloqueia tentativas com ../. Itens com o mesmo ID em dois dispositivos recebem o sufixo \~chave.

Cada episódio também tem um campo key, que é só o caminho relativo codificado. Ele é a chave do progresso no navegador, então o «continuar assistindo» sobrevive se o pendrive voltar com outra letra de unidade.

### 7.4 Metadados (ffprobe)

Para cada arquivo são guardados: codec de vídeo, pix\_fmt, profile, level, altura, duração e a lista de faixas de áudio com codec e idioma. O resultado vai para meta.json e é refeito se o tamanho ou a data do arquivo mudarem. Ao apertar play, o probe sobe na frente da fila (modo urgente).

### 7.5 Decisão de reprodução: plan()

| Modo | Condição | Custo | Seek |
| --- | --- | --- | --- |
| Direto | Contêiner mp4, m4v, mov ou webm; vídeo h264, vp9 ou av1 compatível; faixa de áudio 0 em aac, mp3, opus, vorbis ou flac | Nenhum | Nativo (Range) |
| Cache MP4 | Vídeo copiável e remux anterior concluído | Nenhum | Nativo no início; novo stream ao pular fora do buffer |
| Remux ao vivo | Vídeo copiável (H.264 8 bits 4:2:0 até nível 5.2; HEVC com tag hvc1; VP9 e AV1 só no desktop) e contêiner MKV ou áudio incompatível | Baixo: copia o vídeo e converte o áudio | Novo ffmpeg a cada seek |
| Recodificação | Vídeo não copiável (10 bits, 4:2:2, TV acima de 1080p) ou force=1 | Alto: libx264 ou encoder de hardware | Novo ffmpeg a cada seek |
| HLS (TV) | TV com arquivo que não pode ir direto | Igual ao remux ou à recodificação, em segmentos de 4 s | Nova sessão a cada seek |

**Áudio:** prefere a faixa com idioma por, pt ou pob; se não houver, usa a primeira. O áudio só é copiado quando é aac ou mp3 no desktop; nos demais casos é convertido para AAC estéreo a 192 kbps.

**Recodificação:** escala até 1080p, H.264 High@4.1, yuv420p, keyframe a cada 48 quadros. A ordem de teste dos encoders de hardware é nvenc, qsv, amf e videotoolbox; sem nenhum, usa libx264 em preset superfast, CRF 24, com threads igual à metade dos núcleos. Quando o FFmpeg suporta, a leitura é limitada a 1,5x para poupar CPU. Todo ffmpeg roda com prioridade abaixo do normal.

### 7.6 Cache de MP4 (novo na versão 1.2)

**Problema:** no remux ao vivo, cada seek ou retomada reinicia o ffmpeg com -ss e vídeo copiado. O vídeo só pode começar num keyframe anterior ao ponto pedido, enquanto o áudio recodificado começa no instante exato. A defasagem resultante é o que fazia a voz sair de sincronia depois de reinícios.

**Funcionamento:**

1. Na primeira reprodução em remux (vídeo copiável, fora da TV), startCache() dispara em segundo plano um ffmpeg com -c:v copy, áudio AAC 192k estéreo, aresample=async=1 e +faststart. Ele grava em arquivo .part e só renomeia ao terminar com sucesso. Há no máximo um job por arquivo e faixa de áudio.
2. O resultado fica em .meuflix-cache/v2\_ seguido do SHA-1 de caminho:faixa, com extensão .mp4.
3. Nas requisições seguintes, com t igual a 0 o servidor responde com sendFile (arquivo inteiro, com Range, sem ffmpeg).
4. Com t maior que 0, o ffmpeg lê o MP4 em cache e copia vídeo e áudio juntos (-ss, -c copy, -avoid\_negative\_ts make\_zero). Como os dois fluxos são cortados no mesmo ponto, não há defasagem.
5. Enquanto o cache não existe, o comportamento é o remux ao vivo de sempre.

A conversão leva em geral de 1 a 2 minutos por filme, porque o vídeo não é recodificado. O arquivo em cache tem tamanho próximo ao do original.

### 7.7 HLS para TV

Cada pedido a /api/hls cria uma sessão com ffmpeg, segmentos .ts de 4 s e playlist do tipo event, em .meuflix-cache/hls/id-da-sessão. A resposta só sai quando o primeiro segmento existe (limite de 30 s). Sessões sem acesso por 10 minutos são encerradas e apagadas, a pasta HLS é limpa na inicialização e /api/hls/stop/:sid encerra a sessão explicitamente. Desde a versão 1.2 a playlist é lida em memória antes de ser enviada: com sendFile o Windows mantinha o arquivo aberto e o ffmpeg falhava ao renomear o index.m3u8.tmp.

### 7.8 Legendas e imagens

/sub/:id devolve WebVTT (arquivos SRT são convertidos na hora). /img/:id serve capas com a mesma validação de ID das demais rotas.

## 8. Referência da API

| Rota | Parâmetros | Resposta |
| --- | --- | --- |
| GET /api/library | nenhum | JSON com devices (lista de rótulos) e items; cache de 20 s |
| GET /api/meta/:id | tv=1 | duration, codec, direct, audio, audios |
| GET /stream/:id | t (segundo inicial), tv=1, force=1 | Vídeo: 200 ou 206 no modo direto e no cache; MP4 fragmentado no remux |
| GET /api/hls | id, tv=1, t, force=1 | JSON com a url da playlist |
| GET /hls/:sid/:name | nenhum | Playlist ou segmento |
| GET /api/hls/stop/:sid | nenhum | 204 |
| GET /img/:id | nenhum | Imagem |
| GET /sub/:id | nenhum | WebVTT |

**Modelo de dados principal**

```
Item    { id, type: 'movie' | 'series', title, poster: string | null, rootKey, seasons: Season[] }
Season  { name, episodes: Episode[] }
Episode { id, key, title, originalTitle, sub: boolean, duration: segundos, direct: boolean }
```

Filmes têm uma única temporada com um único episódio.

## 9. Frontend

Aplicação de página única em public/index.html, sem framework. O hls.js só é usado em TVs.

- **Estado:** lib, devs e idx guardam a biblioteca; S descreve a reprodução atual (item, temporada, episódio, base de tempo, duração total, modo direto, tentativas e force). O contador tok invalida respostas assíncronas de reproduções antigas.
- **Relógio:** now() é S.base mais o currentTime do video, e T() é a duração total. No modo ffmpeg o vídeo sempre começa em 0, e base compensa o ponto inicial pedido ao servidor.
- **Biblioteca:** a lista é atualizada a cada 5 s com o player fechado, e a comparação por assinatura JSON evita redesenhar quando nada mudou.
- **Progresso:** localStorage, chave prog, indexada por ep.key, com t, d, ts, item, si e ei. Um título conta como em andamento entre 2% e 95% assistidos; iniciar de novo só retoma se faltarem mais de 30 s.
- **Seek:** no modo direto basta alterar currentTime. No modo ffmpeg, se o ponto está dentro do buffer ajusta-se o tempo relativo; fora dele, pede-se um novo stream com t.
- **Resiliência:** se o stream termina mais de 20 s antes do fim, o player retoma de now() até 2 vezes antes de passar ao próximo episódio. Em erro, ou quando há áudio sem quadros de vídeo, refaz com force=1 (recodificação) e, na TV, memoriza o codec problemático na chave tvBad. As legendas são realinhadas pela base de tempo.
- **Modo TV:** ativado por user agent (Tizen, webOS, Android TV e similares) ou por ?tv=1, com navegação direcional, tela cheia e HLS para arquivos que precisam do ffmpeg.

**Atalhos**

| Tecla | Ação |
| --- | --- |
| Espaço, Enter, K | Play e pausa |
| Seta esquerda e direita | Voltar e avançar 10 s |
| Teclas de mídia (rewind e fast-forward) | 30 s |
| F | Tela cheia |
| M | Mudo |
| C | Legendas |
| Esc, Backspace, GoBack | Fechar o player |

## 10. Segurança e privacidade

- IDs opacos e validados: o cliente não escolhe caminhos, e tentativas de sair da raiz retornam 404.
- **Não há autenticação.** O servidor escuta em 0.0.0.0 para que TV e celular acessem, então qualquer dispositivo da rede local vê a biblioteca. Não exponha a porta à internet nem faça redirecionamento de porta no roteador. Para restringir ao próprio PC, altere o host do listen para 127.0.0.1.
- Não há telemetria; o progresso de reprodução fica apenas no navegador de cada dispositivo.

## 11. Desempenho e recursos

- Modo direto e cache: apenas leitura de disco.
- Remux: carga leve de CPU. Recodificação: CPU ou GPU, com prioridade baixa.
- Mecanismos de contenção: cache de 20 s em /api/library, no máximo 2 ffprobe simultâneos, ffmpeg encerrado quando a conexão fecha e limpeza automática de sessões HLS.
- Recomendações: usar SSD ou USB 3.0, adicionar .meuflix-cache às exclusões do antivírus (Windows Defender) e desativar a suspensão seletiva de USB no plano de energia, que pode pausar HDs externos.

## 12. Solução de problemas

| Sintoma | Causa provável | Ação |
| --- | --- | --- |
| Cannot find module 'express' | Dependências não instaladas | Rodar npm install na pasta do projeto |
| Cannot GET / | index.html fora da pasta public | Colocar em public/index.html (minúsculo) e reiniciar |
| Dispositivo não aparece | Falta Filmes ou Series na raiz | Criar as pastas, aguardar até cerca de 25 s ou passar o caminho como argumento |
| Vídeo sem som | Áudio AC3, EAC3 ou DTS não suportado pelo navegador | O servidor converte via remux; confirme que o log mostra \[OK\] FFmpeg encontrado |
| Travadas e voz fora de sincronia | Remux ao vivo reiniciando com seek, ou leitura lenta do disco | Aguardar o log \[cache\] pronto e reabrir o filme; testar o arquivo no SSD; revisar suspensão USB |
| failed to rename index.m3u8.tmp | Arquivo da playlist travado no Windows | Corrigido na 1.2; excluir .meuflix-cache do antivírus |
| \[AVISO\] FFmpeg não está disponível | FFmpeg fora do PATH | Instalar ou definir FFMPEG\_PATH |
| TV com áudio e sem imagem | Codec não decodificado pela TV | O front tenta force=1; para reavaliar, limpar a chave tvBad do localStorage |
| Filme grande não cabe no pendrive | FAT32 (limite de 4 GB por arquivo) | Formatar em exFAT ou NTFS |

## 13. Limitações conhecidas e roadmap

- **Cache não conta como modo direto no frontend.** O campo direct do episódio vem só de plan(). Resultado: depois do cache pronto, pular para fora do buffer ainda sobe um ffmpeg (agora com cópia de vídeo e áudio, sem defasagem). Melhoria proposta: marcar direct como verdadeiro quando existir cache, em makeEpisode e em /api/meta, apenas fora da TV. O seek passaria a ser nativo, sem ffmpeg.
- **Causa das travadas não comprovada.** O log mostra o player religando o stream várias vezes no mesmo ponto (mecanismo de retomada do onended, até 2 tentativas) sem mensagem de erro do ffmpeg. Diagnóstico sugerido: executar o ffmpeg manualmente com os mesmos argumentos a partir desse ponto, observar o stderr e comparar com o arquivo no SSD.
- O cache não detecta alteração do arquivo original e não tem limpeza automática (por exemplo LRU).
- O mesmo título presente em dois dispositivos aparece como dois itens, sem mesclar temporadas.
- Sem autenticação e sem multiusuário; o progresso é por navegador.
- Legendas apenas externas (.srt e .vtt), com uma única faixa; não há seletor de faixa de áudio na interface.
- O log HTTP registra cada requisição, o que polui o terminal durante o uso.

## 14. Histórico de versões

| Versão | Conteúdo |
| --- | --- |
| 1.0 | Servidor com pasta única, streaming com Range, frontend estilo Netflix, progresso e legendas |
| 1.1 | Detecção automática de vários dispositivos com atualização a quente; ffprobe, modo TV com HLS, encoder de hardware e modos direto, remux e recodificação (incorporados ao server.js do projeto) |
| 1.2 | Cache de MP4 em segundo plano, seek com cópia de vídeo e áudio, playlist HLS lida em memória, cache de 20 s em /api/library |
