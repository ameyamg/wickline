# Wickline

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · Português (Brasil)

Plataforma de gráficos gratuita e de código aberto (gráficos de candles para ações e criptomoedas).
- Cotações ao vivo de criptomoedas, ações da B3 e dos EUA, ETFs, índices, forex e futuros, em qualquer tempo gráfico (2 min, 45 min, 3 h…).
- Grade de opções de ações e ETFs dos EUA, Bitcoin e Ether, com gregas, volatilidade implícita, movimento esperado e max pain.
- 100 indicadores técnicos prontos, e você pode criar seus próprios indicadores e estratégias em JavaScript, com backtest.
- Ferramentas de desenho, alertas de preço e de 1 a 8 gráficos por tela.
- Biblioteca da comunidade: publique seus scripts para todos e adicione os de outras pessoas com um clique.
- Screener, mapa de calor (18 mercados de ações, incluindo o Brasil, e criptomoedas), notícias e calendário econômico, replay de candles e simulador (paper trading).
- Histórico profundo: gráficos de cripto de 1 minuto até 2017 e de ações dos EUA até 2016 com uma chave gratuita da Alpaca (opcional). Fica guardado no seu computador, e o replay pode começar anos atrás. O testador de estratégias também pode usar um intervalo de datas com todo esse histórico.
- Sem cadastro e sem assinatura; nenhuma chave de API é necessária (a da Alpaca é opcional).

**[Baixe o app para desktop](../../releases/latest)** (Windows, macOS, Linux). É só instalar e usar, sem nenhuma configuração.

![Wickline: vários gráficos, indicadores, qualquer tempo gráfico, scripts da comunidade, notícias, replay de candles com simulador, grade de opções e mapa de calor](docs/demo.gif)

## Download

Na página [Releases](../../releases/latest), baixe o arquivo certo para o seu computador:

| Computador | Arquivo |
| --- | --- |
| **Windows** | `Wickline-for-Windows-Portable-x.y.z.exe` (sem instalação, é só executar) ou o instalador `Wickline-for-Windows-Setup-x.y.z.exe` (se atualiza sozinho) |
| **Mac com Apple silicon** (M1, M2, M3, M4 e posteriores) | `Wickline-for-Mac-Apple-Silicon-x.y.z.dmg` |
| Mac com processador Intel (Macs mais antigos) | `Wickline-Intel-Mac-x.y.z.dmg` |
| Linux | `Wickline-Linux-x.y.z.AppImage` (qualquer distribuição, se atualiza sozinho) ou `Wickline-Linux-x.y.z.deb` (Debian, Ubuntu) |

**Atualizações:** o instalador do Windows e o AppImage do Linux baixam as versões novas sozinhos e as instalam ao reiniciar. A versão portátil, o .deb e o app de Mac mostram um aviso com o link de download.

Não sabe qual é o seu Mac? Menu Apple → **Sobre Este Mac**: "Chip: Apple M…" é Apple silicon; "Processador: … Intel" é Intel.

### Primeira execução

O app não é assinado digitalmente (os certificados de assinatura de código são pagos), então aparece um aviso na primeira execução:
- **Windows:** na mensagem "O Windows protegeu o computador", clique em **Mais informações → Executar assim mesmo**.
- **macOS:** arraste o Wickline para a pasta Aplicativos e abra-o. Quando o macOS disser que não pode verificar o app, **não clique em "Mover para o Lixo"**: clique em **Cancelar** (ou **Concluído**), depois vá em **Ajustes do Sistema → Privacidade e Segurança**, role para baixo e clique em **Abrir Mesmo Assim**. No macOS 14 ou anterior, também funciona clicar no app com o botão direito e escolher **Abrir**.
- **O macOS diz que o app "está danificado"** (acontecia nas versões anteriores à 0.1.6 em Macs com Apple silicon): rode `xattr -cr /Applications/Wickline.app` no Terminal.

## Fontes de dados

Ações, ETFs, índices, forex e futuros vêm do Yahoo (B3, EUA, Europa, Ásia e outras bolsas); criptomoedas, da Binance, da Binance Futures, da Coinbase, da Bybit e da OKX; o mapa de calor de cripto, da CoinGecko; opções de ações e ETFs dos EUA, do Yahoo (com cerca de 15 minutos de atraso), e de Bitcoin e Ether, da Deribit (em tempo real). O app roda um pequeno servidor de dados interno, que só escuta no seu próprio computador (`127.0.0.1`), e os dados chegam pela sua própria conexão com a internet.

**Histórico baixado:** ao rolar para trás ou fazer replay, o app baixa o histórico mais antigo e o guarda no seu computador: cripto desde 2017 (arquivo público da Binance) e ações dos EUA desde 2016 com sua própria chave gratuita da [Alpaca](https://alpaca.markets) (⚙ → Fontes de dados → Alpaca; a chave fica só no seu computador e só é enviada para a Alpaca). Downloads pequenos acontecem sozinhos; os grandes perguntam antes. Mais detalhes, em inglês: [Downloaded history](README.md#downloaded-history).

Se o Yahoo, a Binance ou o GitHub estiverem bloqueados na sua rede, no app para desktop vá em ⚙ (Fontes de dados) → **Proxy de rede** e use o proxy do sistema ou um proxy HTTP / SOCKS5 (por exemplo, `127.0.0.1:7890` do Clash). Mais detalhes em inglês: [Using a proxy](README.md#using-a-proxy).

## Idioma da interface

A interface está disponível em Português (Brasil), English, 简体中文, 繁體中文, 日本語, 한국어, Español, Italiano, Deutsch e Français, e segue o idioma do sistema por padrão. Para trocar, clique em ⚙ (Fontes de dados) no canto superior direito → **Idioma (Language)**, escolha o idioma e clique em **Salvar**.

## Feedback

Dúvidas, bugs e sugestões: abra uma [Issue](../../issues) em português ou em inglês.

## Licença

[MIT](LICENSE). Gratuito e de código aberto.
