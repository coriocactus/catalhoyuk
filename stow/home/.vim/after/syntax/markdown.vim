" Markdown as Pi draws it in messages (prose, in Pi's dark theme): headings in
" the terminal's cyan, bold, and H1 underlined; inline code in its yellow, bold;
" links in the theme's blue, underlined; untagged code blocks green; quotes,
" rules, URLs, and the brackets, backticks and fences Pi hides, muted. List
" markers keep the text's colour. Tagged code blocks keep their language's
" colours (after/ftplugin/markdown.vim), as Pi does.
"
" `highlight!` with `default` survives `:colorscheme`, which keeps default links;
" the groups with their own colours are set again on ColorScheme.

" Only for vim-polyglot's syntax ('mkd'). `syntax on` loads Vim's own before
" vim-plug adds polyglot.
if get(b:, 'current_syntax', '') !=# 'mkd'
  finish
endif

" Don't spell-check link text: vim-polyglot's mkdLink region contains @Spell.
syntax match mkdLinkText /[^\]]\+/ contained containedin=mkdLink contains=@NoSpell

" Polyglot puts headings in htmlH1-6, which HTML files share, so they get groups
" of their own here, H1 apart for its underline. Their markers are concealed,
" as fences and strikethrough's are below, which shows where 'conceallevel' is
" set: in Goyo, through pencil.
syntax clear htmlH1 htmlH2 htmlH3 htmlH4 htmlH5 htmlH6
syntax region mkdHeading1 matchgroup=mkdHeading start="^\s*##\@!\s*" end="$" keepend concealends
      \ contains=mkdLink,mkdInlineURL,mkdCode,@Spell
syntax region mkdHeadingText matchgroup=mkdHeading start="^\s*#\{2,6}\s*" end="$" keepend concealends
      \ contains=mkdLink,mkdInlineURL,mkdCode,@Spell
syntax match mkdHeading1 /^.\+\n=\+$/ contains=mkdLink,mkdInlineURL,mkdCode,@Spell
syntax match mkdHeadingText /^.\+\n-\+$/ contains=mkdLink,mkdInlineURL,mkdCode,@Spell
syntax cluster mkdNonListItem add=mkdHeading1,mkdHeadingText

" Quotes also hold inline code, which polyglot's do not. keepend stops it at the
" end of the line.
syntax clear mkdBlockquote
syntax region mkdBlockquote start=/^\s*>/ end=/$/ keepend
      \ contains=mkdLink,mkdInlineURL,mkdLineBreak,mkdCode,@Spell

" Polyglot takes ~~ for code unless g:vim_markdown_strikethrough is set, and its
" cluster already names mkdStrike.
syntax region mkdStrike matchgroup=mkdStrikeDelimiter start=/\~\~/ end=/\~\~/ keepend concealends
      \ contains=@Spell

" Polyglot puts untagged code blocks in mkdCode with inline code; Pi draws them
" green, and inline code yellow. Same patterns, defined later, so these win.
" A concealed fence leaves its line blank: Vim cannot hide a line.
syntax region mkdCodeBlock matchgroup=mkdCodeFence start=/^\s*\z(`\{3,}\)[^`]*$/ end=/^\s*\z1`*\s*$/
      \ concealends
syntax region mkdCodeBlock matchgroup=mkdCodeFence concealends
      \ start=/^\s*\z(\~\{3,}\)\s*[0-9A-Za-z_+-]*\s*$/ end=/^\s*\z1\~*\s*$/
syntax match mkdCodeBlock /^\s*\n\(\(\s\{8,}[^ ]\|\t\t\+[^\t]\).*\n\)\+/
syntax match mkdCodeBlock /\%^\(\(\s\{4,}[^ ]\|\t\+[^\t]\).*\n\)\+/
syntax match mkdCodeBlock /^\s*\n\(\(\s\{4,}[^ ]\|\t\+[^\t]\).*\n\)\+/ contained
syntax cluster mkdNonListItem add=mkdCodeBlock

let s:links = {
      \ 'mkdHeading': 'mkdHeadingText',
      \ 'mkdCode': 'mkdInlineCode',
      \ 'mkdBlockquote': 'mkdQuote',
      \ 'mkdLink': 'mkdLinkText',
      \ 'mkdInlineURL': 'mkdLinkText',
      \ 'mkdStrike': 'mkdStrikeText',
      \ 'mkdItalic': 'htmlItalic',
      \ 'mkdBold': 'htmlBold',
      \ 'mkdBoldItalic': 'htmlBoldItalic',
      \ }
for s:group in ['mkdCodeDelimiter', 'mkdCodeFence', 'mkdCodeStart', 'mkdCodeEnd', 'mkdRule',
      \ 'mkdURL', 'mkdLinkDefTarget', 'mkdLinkTitle', 'mkdID', 'mkdLinkDef', 'mkdDelimiter',
      \ 'mkdStrikeDelimiter']
  let s:links[s:group] = 'mkdMuted'
endfor
for s:group in ['mkdListItem', 'mkdLineBreak', 'mkdFootnote', 'mkdFootnotes']
  let s:links[s:group] = 'NONE'
endfor
for [s:group, s:target] in items(s:links)
  execute 'highlight! default link' s:group s:target
endfor
unlet s:links s:group s:target

" Palette entries 3 and 6 are the terminal's yellow and cyan, as in Pi's
" shared/colours.ts; the rest are Pi's dark theme (mdLink, muted, mdCodeBlock)
" and their nearest xterm colours. `:colorscheme` also clears html.vim's bold
" and italic, so put them back unless the colour scheme sets its own.
function! s:Colours() abort
  highlight mkdHeading1 ctermfg=6 cterm=bold,underline gui=bold,underline
  highlight mkdHeadingText ctermfg=6 cterm=bold gui=bold
  highlight mkdInlineCode ctermfg=3 cterm=bold gui=bold
  highlight mkdCodeBlock ctermfg=72 guifg=#68b78d
  highlight mkdLinkText ctermfg=74 cterm=underline guifg=#69add0 gui=underline
  highlight mkdMuted ctermfg=248 guifg=#9da5a9
  highlight mkdQuote ctermfg=248 cterm=italic guifg=#9da5a9 gui=italic
  highlight mkdStrikeText cterm=strikethrough gui=strikethrough
  highlight default htmlBold term=bold cterm=bold gui=bold
  highlight default htmlItalic term=italic cterm=italic gui=italic
  highlight default htmlBoldItalic term=bold,italic cterm=bold,italic gui=bold,italic
endfunction
call s:Colours()

augroup markdown_colours
  autocmd!
  autocmd ColorScheme * call s:Colours()
augroup END
