" Darkside: the Ghostty/iTerm2 "Darkside" palette for Vim.
"
" Accents are ANSI colours 0-15, so terminal Vim inherits them from the
" terminal's own palette. Neutral shades come from the 256-colour grey ramp,
" and the background stays transparent. Hex values apply with 'termguicolors'.

set background=dark
highlight clear
if exists('syntax_on') | syntax reset | endif
let g:colors_name = 'darkside'

" [gui, cterm]
let s:none     = ['NONE', 'NONE']
let s:black    = ['#000000', 0]
let s:red      = ['#e8341c', 1]
let s:green    = ['#68c256', 2]
let s:yellow   = ['#f2d42c', 3]
let s:blue     = ['#1c98e8', 4]
let s:magenta  = ['#8e69c9', 5]
let s:fg       = ['#bababa', 7]
let s:gray     = ['#4c4c4c', 8]
let s:coral    = ['#e05a4f', 9]
let s:lyellow  = ['#efd64b', 11]
let s:indigo   = ['#387cd3', 12]
let s:lavender = ['#957bbe', 13]
let s:sky      = ['#3d97e2', 14]

let s:bg      = ['#222324', 'NONE']
let s:line    = ['#2c2d2e', 236]
let s:raised  = ['#3a3d3d', 237]
let s:visual  = ['#005f87', 24]
let s:linenr  = ['#5a5b5c', 240]
let s:comment = ['#767778', 243]

let s:add    = ['#26381f', 22]
let s:delete = ['#3d2321', 52]
let s:change = ['#1d2b3a', 17]
let s:text   = ['#1f4566', 24]

let s:has_ctermul = has('patch-8.2.0863')

" s:hi(group, fg, bg [, attr [, special]])
function! s:hi(group, fg, bg, ...) abort
  let l:attr = get(a:, 1, 'NONE')
  let l:command = ['highlight', a:group,
        \ 'guifg=' . a:fg[0], 'ctermfg=' . a:fg[1],
        \ 'guibg=' . a:bg[0], 'ctermbg=' . a:bg[1],
        \ 'gui=' . l:attr, 'cterm=' . l:attr]
  if a:0 >= 2
    call add(l:command, 'guisp=' . a:2[0])
    if s:has_ctermul | call add(l:command, 'ctermul=' . a:2[1]) | endif
  endif
  execute join(l:command)
endfunction

" Editor
call s:hi('Normal', s:fg, s:bg)
call s:hi('Cursor', ['#ffffff', 'NONE'], ['#bbbbbb', 'NONE'])
call s:hi('CursorLine', s:none, s:line)
call s:hi('CursorColumn', s:none, s:line)
call s:hi('ColorColumn', s:none, s:line)
call s:hi('CursorLineNr', s:yellow, s:line, 'bold')
call s:hi('LineNr', s:linenr, s:none)
call s:hi('SignColumn', s:none, s:none)
call s:hi('FoldColumn', s:linenr, s:none)
call s:hi('Folded', s:comment, s:line)
call s:hi('NonText', s:gray, s:none)
call s:hi('EndOfBuffer', s:gray, s:none)
call s:hi('SpecialKey', s:gray, s:none)
call s:hi('Conceal', s:gray, s:none)
call s:hi('VertSplit', s:gray, s:none)
call s:hi('Visual', s:fg, s:visual)
call s:hi('VisualNOS', s:fg, s:visual)
call s:hi('Search', s:black, s:yellow)
call s:hi('IncSearch', s:black, s:coral)
call s:hi('CurSearch', s:black, s:coral)
call s:hi('MatchParen', s:yellow, s:raised, 'bold')
call s:hi('Directory', s:blue, s:none)
call s:hi('Title', s:yellow, s:none, 'bold')
call s:hi('QuickFixLine', s:yellow, s:none, 'bold')

" Status, tabs, menus
call s:hi('StatusLine', s:fg, s:raised)
call s:hi('StatusLineNC', s:comment, s:line)
call s:hi('StatusLineTerm', s:fg, s:raised)
call s:hi('StatusLineTermNC', s:comment, s:line)
call s:hi('TabLine', s:comment, s:line)
call s:hi('TabLineFill', s:none, s:line)
call s:hi('TabLineSel', s:fg, s:none, 'bold')
call s:hi('Pmenu', s:fg, s:line)
call s:hi('PmenuSel', s:black, s:blue)
call s:hi('PmenuSbar', s:none, s:raised)
call s:hi('PmenuThumb', s:none, s:gray)
call s:hi('PmenuMatch', s:yellow, s:line, 'bold')
call s:hi('PmenuMatchSel', s:black, s:blue, 'bold')
call s:hi('PmenuShadow', s:black, s:black)
call s:hi('WildMenu', s:black, s:blue)
call s:hi('ToolbarLine', s:none, s:line)
call s:hi('ToolbarButton', s:fg, s:raised, 'bold')

" Messages
call s:hi('ModeMsg', s:yellow, s:none, 'bold')
call s:hi('MoreMsg', s:green, s:none)
call s:hi('Question', s:green, s:none)
call s:hi('WarningMsg', s:yellow, s:none)
call s:hi('ErrorMsg', s:red, s:none, 'bold')

" Spelling
call s:hi('SpellBad', s:none, s:none, 'undercurl', s:red)
call s:hi('SpellCap', s:none, s:none, 'undercurl', s:blue)
call s:hi('SpellRare', s:none, s:none, 'undercurl', s:magenta)
call s:hi('SpellLocal', s:none, s:none, 'undercurl', s:sky)

" Diffs
call s:hi('DiffAdd', s:none, s:add)
call s:hi('DiffChange', s:none, s:change)
call s:hi('DiffDelete', s:red, s:delete)
call s:hi('DiffText', s:none, s:text, 'bold')
call s:hi('Added', s:green, s:none)
call s:hi('Changed', s:yellow, s:none)
call s:hi('Removed', s:red, s:none)
highlight! link diffAdded Added
highlight! link diffChanged Changed
highlight! link diffRemoved Removed
call s:hi('diffFile', s:yellow, s:none, 'bold')
call s:hi('diffLine', s:blue, s:none)
call s:hi('diffIndexLine', s:comment, s:none)

" Syntax
call s:hi('Comment', s:comment, s:none)
call s:hi('Constant', s:lavender, s:none)
call s:hi('String', s:green, s:none)
call s:hi('Character', s:green, s:none)
call s:hi('Identifier', s:fg, s:none)
call s:hi('Function', s:blue, s:none)
call s:hi('Statement', s:coral, s:none)
call s:hi('Operator', s:fg, s:none)
call s:hi('PreProc', s:indigo, s:none)
call s:hi('Type', s:yellow, s:none)
call s:hi('Special', s:red, s:none)
call s:hi('Tag', s:blue, s:none)
call s:hi('Delimiter', s:fg, s:none)
call s:hi('SpecialComment', s:comment, s:none, 'bold')
call s:hi('Underlined', s:indigo, s:none, 'underline')
call s:hi('Ignore', s:gray, s:none)
call s:hi('Error', s:black, s:red)
call s:hi('Todo', s:yellow, s:none, 'bold')

" Identifier and Operator stay plain for variables and operators, but some
" syntax files link markup, keys, keywords, types and tags to them. Give those
" the colour their siblings already have.

" Markdown: list markers and rules like slate's; reference links like links.
call s:hi('mkdListItem', s:coral, s:none)
call s:hi('mkdRule', s:coral, s:none)
highlight! link mkdID Underlined
highlight! link mkdLinkDef Underlined

" Help links like markdown links; commit hashes like git's own colouring.
highlight! link helpHyperTextJump Underlined
call s:hi('gitcommitHash', s:yellow, s:none)
call s:hi('fugitiveHash', s:yellow, s:none)

" YAML and TOML keys like JSON keys.
highlight! link yamlBlockMappingKey Statement
highlight! link yamlFlowMappingKey Statement
highlight! link tomlKey Statement
highlight! link tomlKeyDq Statement
highlight! link tomlKeySq Statement

" HTML/JSX: closing tags like opening tags, <div> like HTML tag names.
highlight! link htmlEndTag Function
highlight! link jsxTagName Statement

" TypeScript: const/enum/typeof/new like function/class/return; type
" references like predefined types; alias names like interface names.
highlight! link typescriptVariable Statement
highlight! link typescriptEnumKeyword Statement
highlight! link typescriptOperator Statement
highlight! link typescriptKeywordOp Statement
highlight! link typescriptConstructSignature Statement
highlight! link typescriptTypeReference Type
highlight! link typescriptTypeParameter Type
highlight! link typescriptAliasDeclaration Function

" Python: and/or/not/in/is like keywords; __name__ etc. like constants.
highlight! link pythonOperator Statement
highlight! link pythonBuiltinObj Constant

" ALE
call s:hi('ALEError', s:none, s:none, 'undercurl', s:red)
call s:hi('ALEWarning', s:none, s:none, 'undercurl', s:yellow)
call s:hi('ALEInfo', s:none, s:none, 'undercurl', s:blue)
call s:hi('ALEErrorSign', s:red, s:none, 'bold')
call s:hi('ALEWarningSign', s:yellow, s:none, 'bold')
call s:hi('ALEInfoSign', s:blue, s:none, 'bold')
call s:hi('ALEVirtualTextError', s:coral, s:none)
call s:hi('ALEVirtualTextWarning', s:lyellow, s:none)
call s:hi('ALEVirtualTextInfo', s:comment, s:none)

" netrw
call s:hi('netrwTreeBar', s:gray, s:none)
call s:hi('netrwGray', s:comment, s:none)
call s:hi('netrwExe', s:green, s:none)
call s:hi('netrwSymLink', s:lavender, s:none)

" :terminal under 'termguicolors'
let g:terminal_ansi_colors = [
      \ '#000000', '#e8341c', '#68c256', '#f2d42c',
      \ '#1c98e8', '#8e69c9', '#1c98e8', '#bababa',
      \ '#4c4c4c', '#e05a4f', '#77b869', '#efd64b',
      \ '#387cd3', '#957bbe', '#3d97e2', '#bababa',
\]
