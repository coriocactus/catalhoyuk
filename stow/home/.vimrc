" =================================================================================================
" headings:
" https://patorjk.com/software/taag/#p=display&f=Terrace&t=.vimrc&x=none&v=4&h=4&w=80&we=false
" =================================================================================================
" ▬▬▬.◙.▬▬▬
" ═▂▄▄▓▄▄▂
" ◢◤ █▀▀████▄▄▄◢◤
" █▄ █ █▄ ███▀▀▀▀▀▀╬
" ◥█████◤
" ══╩══╩═
" ╬═╬
" ╬═╬
" ╬═╬
" ╬═╬
" ╬═╬ { .vimrc }
" ╬═╬☻/
" ╬═╬/▌
" ╬═╬/  \
" =================================================================================================
" ░██                              ░██
" ░██
" ░████████   ░██████    ░███████  ░██ ░███████   ░███████
" ░██    ░██       ░██  ░██        ░██░██    ░██ ░██
" ░██    ░██  ░███████   ░███████  ░██░██         ░███████
" ░███   ░██ ░██   ░██         ░██ ░██░██    ░██        ░██
" ░██░█████   ░█████░██  ░███████  ░██ ░███████   ░███████

set nocompatible

let VIM_DIR = $HOME . '/.vim'
let BACKUP_DIR = $HOME . '/.vim/backup'
let SWAP_DIR = $HOME . '/.vim/swap'
let UNDO_DIR = $HOME . '/.vim/undo'
if !isdirectory(VIM_DIR) | call mkdir(VIM_DIR, '', 0770) | endif
if !isdirectory(SWAP_DIR) | call mkdir(SWAP_DIR, '', 0700) | endif
if !isdirectory(UNDO_DIR) | call mkdir(UNDO_DIR, '', 0700) | endif
if !isdirectory(BACKUP_DIR) | call mkdir(BACKUP_DIR, '', 0700) | endif
let &directory = escape(SWAP_DIR, ',') . '//'
let &undodir = escape(UNDO_DIR, ',') . '//'
let &backupdir = escape(BACKUP_DIR, ',') . '//'
set swapfile
set undofile
set backup

set number
set relativenumber
set ruler
set showcmd
set showmode

set expandtab
set shiftwidth=2
set softtabstop=2
set backspace=indent,eol,start

set hidden
set nowrap
set autoindent
set hlsearch
set belloff=all
set signcolumn=number
set colorcolumn=80
set laststatus=0
set cursorline
set scrolloff=0

" use newer/faster regex engine automatically
set regexpengine=0  
set redrawtime=2000

" newer vim packages netrw separately (older versions already have it on runtimepath)
silent! packadd! netrw

" run git before terminal queries: system() in VimEnter can echo their replies.
let g:netrw_list_hide = join(uniq(sort(split(netrw_gitignore#Hide() .. ',\(^\|\s\s\)\zs\.\S\+,.*\.swp$,.DS_Store,*/tmp/*,*.so,*.zip,^\.git/$,^\.\.\=/\=$', ','))), ',')
let g:netrw_hide = 1
let g:netrw_liststyle = 3

augroup netrw_startup
  autocmd!
  autocmd VimEnter * if argc() == 0 | Explore | endif
augroup END

augroup remember_folds
  autocmd!
  autocmd BufWinLeave * if &buftype == '' && !empty(expand('%')) | mkview | endif
  autocmd BufWinEnter * if &buftype == '' && !empty(expand('%')) | silent! loadview | endif
augroup END

" =================================================================================================
"    ░██    ░██
"    ░██    ░██
" ░████████ ░████████   ░███████  ░█████████████   ░███████
"    ░██    ░██    ░██ ░██    ░██ ░██   ░██   ░██ ░██    ░██
"    ░██    ░██    ░██ ░█████████ ░██   ░██   ░██ ░█████████
"    ░██    ░██    ░██ ░██        ░██   ░██   ░██ ░██
"     ░████ ░██    ░██  ░███████  ░██   ░██   ░██  ░███████

syntax on
" Fall back to slate where ~/.vim/colors/darkside.vim was not installed.
try
  colorscheme darkside
catch /^Vim\%((\a\+)\)\=:E185:/
  colorscheme slate
  highlight Normal ctermbg=NONE
  highlight ColorColumn ctermbg=238
  highlight ModeMsg ctermfg=3 ctermbg=NONE cterm=bold guifg=#f2d42c guibg=NONE gui=bold
endtry

" =================================================================================================
"                                  ░██
"
"  ░███████  ░████████  ░██    ░██ ░██░██░████  ░███████  ░████████   ░███████
" ░██    ░██ ░██    ░██ ░██    ░██ ░██░███     ░██    ░██ ░██    ░██ ░██
" ░█████████ ░██    ░██  ░██  ░██  ░██░██      ░██    ░██ ░██    ░██  ░███████
" ░██        ░██    ░██   ░██░██   ░██░██      ░██    ░██ ░██    ░██        ░██
"  ░███████  ░██    ░██    ░███    ░██░██       ░███████  ░██    ░██  ░███████

if $TERM=='screen-256color' | set ttymouse=xterm2 | endif

if &term =~ "screen\\|tmux"
  let &t_BE = "\e[?2004h"
  let &t_BD = "\e[?2004l"
  exec "set t_PS=\e[200~"
  exec "set t_PE=\e[201~"
endif

" =================================================================================================
"                          ░██                              ░██ ░██
"                          ░██                             ░██  ░██
"  ░███████  ░████████  ░████████  ░███████  ░██░████     ░██   ░██  ░███████   ░██████   ░██    ░██  ░███████
" ░██    ░██ ░██    ░██    ░██    ░██    ░██ ░███        ░██    ░██ ░██    ░██       ░██  ░██    ░██ ░██    ░██
" ░█████████ ░██    ░██    ░██    ░█████████ ░██        ░██     ░██ ░█████████  ░███████   ░██  ░██  ░█████████
" ░██        ░██    ░██    ░██    ░██        ░██       ░██      ░██ ░██        ░██   ░██    ░██░██   ░██
"  ░███████  ░██    ░██     ░████  ░███████  ░██      ░██       ░██  ░███████   ░█████░██    ░███     ░███████

function! s:TmuxTitle(name) abort
  if !empty($TMUX) && executable('tmux')
    call system('tmux rename-window -- ' . shellescape(a:name))
  endif
endfunction

augroup tmux_title
  autocmd!
  autocmd BufReadPost,FileReadPost,BufNewFile,BufEnter,FocusGained * call <SID>TmuxTitle(expand('%:t'))
  autocmd VimLeave * call <SID>TmuxTitle(fnamemodify($SHELL, ':t'))
augroup END

" =================================================================================================
"            ░██                       ░██
"            ░██
" ░████████  ░██ ░██    ░██  ░████████ ░██░████████   ░███████
" ░██    ░██ ░██ ░██    ░██ ░██    ░██ ░██░██    ░██ ░██
" ░██    ░██ ░██ ░██    ░██ ░██    ░██ ░██░██    ░██  ░███████
" ░███   ░██ ░██ ░██   ░███ ░██   ░███ ░██░██    ░██        ░██
" ░██░█████  ░██  ░█████░██  ░█████░██ ░██░██    ░██  ░███████
" ░██                              ░██
" ░██                        ░███████

function! s:Plugins() abort
  call plug#begin()
    Plug 'mbbill/undotree'
    Plug 'markonm/traces.vim'
    Plug 'yggdroot/indentline'
    Plug 'tpope/vim-fugitive'
    Plug 'junegunn/fzf', { 'do': { -> fzf#install() } }
    Plug 'junegunn/fzf.vim'
    Plug 'ojroques/vim-oscyank', {'branch': 'main'}
    Plug 'sheerun/vim-polyglot'
    Plug 'dense-analysis/ale'
    Plug 'junegunn/goyo.vim'
    Plug 'junegunn/limelight.vim'
    Plug 'preservim/vim-pencil'
    Plug 'godlygeek/tabular'
  call plug#end()
endfunction

" Installation is explicit. Normal startup never downloads or installs plugins.
function! s:BootstrapPlugins() abort
  let l:plug = g:VIM_DIR . '/autoload/plug.vim'
  if !filereadable(l:plug)
    call mkdir(fnamemodify(l:plug, ':h'), 'p', 0700)
    let l:temporary = trim(system('mktemp ' . shellescape(l:plug . '.XXXXXX')))
    if v:shell_error | throw 'Cannot create vim-plug download file' | endif
    try
      let l:output = system('curl --fail --location --silent --show-error --output '
            \ . shellescape(l:temporary)
            \ . ' https://raw.githubusercontent.com/junegunn/vim-plug/0.14.0/plug.vim')
      if v:shell_error | throw 'vim-plug download failed: ' . l:output | endif
      if rename(l:temporary, l:plug) != 0 | throw 'Cannot install vim-plug' | endif
    finally
      call delete(l:temporary)
    endtry
  endif
  call s:Plugins()
  PlugInstall --sync
  echom 'Plugin installation finished; check the results and restart Vim.'
endfunction
command! BootstrapPlugins call s:BootstrapPlugins()

if filereadable(VIM_DIR . '/autoload/plug.vim')
  call s:Plugins()
endif

let g:python_recommended_style = 0
let g:undotree_SetFocusWhenToggle = 1
let g:indentLine_fileTypeExclude = ['json', 'markdown', 'tex', 'text']

" Writing mode: Goyo centres a 99-column page; \0 toggles Limelight, which dims
" other paragraphs (off by default).
" Goyo opens its own tab, so window-local options set here vanish on leave.
let g:goyo_width = 99
let g:limelight_conceal_ctermfg = 240
let g:limelight_conceal_guifg = '#5a5b5c'
" Soft-wrap only at whitespace, never mid-URL. Global; only affects 'linebreak' windows.
let &breakat = " \t"

let s:has_pencil = !empty(globpath(&runtimepath, 'autoload/pencil.vim'))
let s:goyo_quit = ''

" Goyo blanks every status line and its bottom pad owns the ruler, so put the
" position in the text window's status line, just under the page. Runs after
" Goyo's own WinEnter/WinLeave/BufWinEnter blanking. Two rows (Vim 9.2+), the
" first left blank as a gap; fixedheight stops the layout jumping when Goyo
" briefly blanks it. Word count on the left, position on the right.
function! s:GoyoStatus() abort
  if exists('t:goyo_pads') && index(values(t:goyo_pads), bufnr('')) < 0
    setlocal statuslineopt=maxheight:2,fixedheight
    let &l:statusline = '%@%{' . expand('<SID>') . 'GoyoWords()}%=%l/%L  %P'
  endif
endfunction

" wordcount() scans the whole buffer, so only recount after a change.
function! s:GoyoWords() abort
  if get(b:, 'goyo_words_tick', -1) != b:changedtick
    let b:goyo_words = wordcount().words
    let b:goyo_words_tick = b:changedtick
  endif
  return b:goyo_words . (b:goyo_words == 1 ? ' word' : ' words')
endfunction

" Goyo makes StatusLine invisible. On leave it clears #goyo, then reloads the
" colorscheme, which must not re-apply this.
function! s:GoyoStatusColor() abort
  if exists('#goyo')
    highlight StatusLine ctermfg=240 ctermbg=NONE cterm=NONE guifg=#5a5b5c guibg=NONE gui=NONE
  endif
endfunction

" [first, last] lines of the pipe table under the cursor, or [] if none.
function! s:TableRange() abort
  let l:first = line('.')
  let l:last = line('.')
  if getline(l:first) !~# '^\s*|'
    echomsg 'Cursor is not in a table'
    return []
  endif
  while l:first > 1 && getline(l:first - 1) =~# '^\s*|' | let l:first -= 1 | endwhile
  while l:last < line('$') && getline(l:last + 1) =~# '^\s*|' | let l:last += 1 | endwhile
  return [l:first, l:last]
endfunction

" \| toggles the table under the cursor: compact if its pipes already line up,
" aligned otherwise.
function! s:ToggleTable() abort
  let l:range = s:TableRange()
  if empty(l:range) | return | endif
  let l:pipes = map(getline(l:range[0], l:range[1]), {_, l -> s:PipeColumns(l)})
  if empty(filter(copy(l:pipes), {_, p -> p != l:pipes[0]}))
    call s:CompactTable(l:range)
  else
    call s:AlignTable(l:range)
  endif
endfunction

" Display columns of a row's unescaped pipes.
function! s:PipeColumns(line) abort
  let l:columns = []
  let l:width = 0
  for l:cell in split(a:line, '\\\@<!|', 1)[:-2]
    let l:width += strdisplaywidth(l:cell)
    call add(l:columns, l:width)
    let l:width += 1
  endfor
  return l:columns
endfunction

" vim-polyglot's markdown :TableFormat aligns the table under the cursor (needs
" tabular). Tabular pads the empty field before the leading pipe, indenting the
" table by a space, so restore the table's original indent afterwards.
function! s:AlignTable(range) abort
  if exists(':TableFormat') != 2
    echomsg 'No :TableFormat for this filetype'
    return
  endif
  let [l:first, l:last] = a:range
  let l:indent = matchstr(getline(l:first), '^\s*')
  TableFormat
  call setline(l:first, map(getline(l:first, l:last), {_, l -> substitute(l, '^\s*', l:indent, '')}))
endfunction

" One space around each cell and --- separators, keeping alignment colons and
" the table's indent. Escaped \| pipes stay inside their cell.
function! s:CompactTable(range) abort
  let [l:first, l:last] = a:range
  call setline(l:first, map(getline(l:first, l:last), {_, l -> s:CompactRow(l)}))
endfunction

function! s:CompactRow(line) abort
  let l:indent = matchstr(a:line, '^\s*')
  let l:body = trim(a:line)
  let l:trailing = l:body =~# '\\\@<!|$'
  " Drop the empty field before the leading pipe, and after a trailing one.
  let l:cells = map(split(l:body, '\\\@<!|', 1)[1:], {_, c -> trim(c)})
  if l:trailing | call remove(l:cells, -1) | endif
  if empty(filter(copy(l:cells), {_, c -> c !~# '^:\=-\+:\=$'}))
    call map(l:cells, {_, c -> (c =~# '^:' ? ':' : '') . '---' . (c =~# ':$' ? ':' : '')})
  endif
  return l:indent . '| ' . join(l:cells, ' | ') . (l:trailing ? ' |' : '')
endfunction

function! s:GoyoEnter() abort
  setlocal wrap linebreak spell spelllang=en_us
  if s:has_pencil && index(['markdown', 'text'], &filetype) >= 0
    call pencil#init({'wrap': 'soft'})
  endif
  call s:GoyoStatus()
  call s:GoyoStatusColor()
  nnoremap <leader>0 <cmd>Limelight!!<CR>
  let s:goyo_quit = ''
  augroup goyo_session
    autocmd!
    autocmd WinEnter,WinLeave,BufWinEnter * call s:GoyoStatus()
    autocmd ColorScheme * call s:GoyoStatusColor()
    " :q only closes Goyo's window, so record it and repeat it after Goyo exits.
    autocmd QuitPre * let s:goyo_quit = histget(':', -1) =~# '^\s*\a*!' ? 'quit!' : 'quit'
  augroup END
endfunction

" Runs back in the original window. Pencil's off mode resets buffer options to
" global defaults, so re-run the filetype plugins to restore their settings.
function! s:GoyoLeave() abort
  Limelight!
  silent! nunmap <leader>0
  if get(b:, 'pencil_wrap_mode', 0)
    call pencil#init({'wrap': 'off'})
    let &l:filetype = &l:filetype
  endif
  autocmd! goyo_session
  let l:quit = s:goyo_quit
  let s:goyo_quit = ''
  if !empty(l:quit)
    try
      execute l:quit
    catch
      echohl ErrorMsg | echomsg substitute(v:exception, '^Vim(\a\+):', '', '') | echohl None
    endtry
  endif
endfunction

augroup writing
  autocmd!
  autocmd User GoyoEnter call s:GoyoEnter()
  " ++nested so a repeated :q still fires ExitPre/VimLeave autocmds.
  autocmd User GoyoLeave ++nested call s:GoyoLeave()
augroup END

" =================================================================================================
" ░██ ░██              ░██                                    ░██    ░██
" ░██                  ░██                                    ░██    ░██
" ░██ ░██░████████  ░████████     ░██████   ░████████   ░████████    ░██  ░███████  ░████████
" ░██ ░██░██    ░██    ░██             ░██  ░██    ░██ ░██    ░██    ░██ ░██        ░██    ░██
" ░██ ░██░██    ░██    ░██        ░███████  ░██    ░██ ░██    ░██    ░██  ░███████  ░██    ░██
" ░██ ░██░██    ░██    ░██       ░██   ░██  ░██    ░██ ░██   ░███    ░██        ░██ ░███   ░██
" ░██ ░██░██    ░██     ░████     ░█████░██ ░██    ░██  ░█████░██    ░██  ░███████  ░██░█████
"                                                                                   ░██

let g:ale_floating_preview = 1
let g:ale_completion_enabled = 1
let g:ale_python_auto_uv = 1
let g:ale_python_pylsp_auto_uv = 1
let g:ale_python_ruff_auto_uv = 1
let g:ale_python_pylsp_config = {'pylsp': {
      \ 'plugins': {
      \   'pylsp_mypy': { 'enabled': v:false },
      \ },
\}}

let s:has_ale = !empty(globpath(&runtimepath, 'autoload/ale.vim'))
if s:has_ale
  call ale#Set('typescript_tsgo_executable', 'tsc')
  call ale#Set('typescript_tsgo_use_global', 0)
  call ale#linter#Define('typescript', {
        \ 'name': 'tsgo',
        \ 'lsp': 'stdio',
        \ 'language': {buffer -> getbufvar(buffer, '&filetype')},
        \ 'executable': {buffer -> ale#path#FindExecutable(
        \   buffer,
        \   'typescript_tsgo',
        \   ['node_modules/.bin/tsc'],
        \ )},
        \ 'command': '%e --lsp --stdio',
        \ 'project_root': function('ale#handlers#tsserver#GetProjectRoot'),
  \})

  set omnifunc=ale#completion#OmniFunc
  nnoremap <leader>a <cmd>ALEToggleBuffer<CR>
  nnoremap <silent> K <cmd>ALEHover<CR>
  nnoremap <silent> [g <cmd>ALENext<CR>
  nnoremap <silent> ]g <cmd>ALEPrevious<CR>
  nnoremap <silent> gd <cmd>ALEGoToDefinition<CR>
  nnoremap <silent> gr <cmd>ALEFindReferences<CR>
  nnoremap <silent> ca <cmd>ALECodeAction<CR>
endif
set completeopt=menu,noselect

let g:ale_linters = {
      \ 'python': ['pylsp', 'ruff'],
      \ 'elixir': ['expert'],
      \ 'rust': ['analyzer', 'cargo'],
      \ 'haskell': ['hls'],
      \ 'zig': ['zls'],
      \ 'javascript': ['biome', 'tsserver', 'eslint'],
      \ 'javascriptreact': ['biome', 'tsserver', 'eslint'],
      \ 'typescript': ['biome', 'tsserver', 'eslint'],
      \ 'typescriptreact': ['biome', 'tsserver', 'eslint'],
      \ 'html': ['djlint'],
      \ 'css': ['stylelint'],
\}

" Keep build.zig roots; use the file's directory for standalone Zig files.
function! ZigAleRoot(buffer) abort
  let l:build = ale#path#FindNearestFile(a:buffer, 'build.zig')
  if !empty(l:build)
    return fnamemodify(l:build, ':h')
  endif
  return fnamemodify(bufname(a:buffer), ':p:h')
endfunction

let g:ale_root = get(g:, 'ale_root', {})
let g:ale_root.zls = function('ZigAleRoot')

function! ConfigureTypeScriptAle() abort
  let b:ale_linters = ['biome']

  let l:typescript_package = ale#path#FindNearestFile(
        \ bufnr(''),
        \ 'node_modules/typescript/package.json',
  \)

  if !empty(l:typescript_package)
    try
      let l:typescript = json_decode(join(readfile(l:typescript_package), "\n"))
      let l:server = str2nr(get(l:typescript, 'version', '')) >= 7
            \ ? 'tsgo'
            \ : 'tsserver'
      call add(b:ale_linters, l:server)
    catch
    endtry
  elseif executable('tsserver')
    call add(b:ale_linters, 'tsserver')
  endif

  let l:eslint_config = ale#handlers#eslint#FindConfig(bufnr(''))

  if !empty(l:eslint_config)
    if fnamemodify(l:eslint_config, ':t') isnot# 'package.json'
      call add(b:ale_linters, 'eslint')
    else
      try
        let l:package = json_decode(join(readfile(l:eslint_config), "\n"))

        if has_key(l:package, 'eslintConfig')
          call add(b:ale_linters, 'eslint')
        endif
      catch
      endtry
    endif
  endif
endfunction

augroup ale_typescript
  autocmd!
  if s:has_ale
    autocmd FileType typescript,typescriptreact call ConfigureTypeScriptAle()
  endif
augroup END

if executable('zig')
  let g:zig_std_dir = matchstr(system('zig env'), 'std_dir"\?\s*[:=]\s*"\zs[^"]*')
endif

" =================================================================================================
"               ░██    ░██░██
"               ░██       ░██
" ░██    ░██ ░████████ ░██░██  ░███████
" ░██    ░██    ░██    ░██░██ ░██
" ░██    ░██    ░██    ░██░██  ░███████
" ░██   ░███    ░██    ░██░██        ░██
"  ░█████░██     ░████ ░██░██  ░███████

function! SensibleLineWidth(...)
  let l:max_length = a:0 >= 1 ? a:1 : 80
  let @/ = '\%>' . l:max_length . 'v.\+'
  if search(@/, 'n') > 0
    normal! n
  else
    echo 'No lines longer than ' . l:max_length . ' characters.'
  endif
endfunction
command! -nargs=? SensibleLineWidth call SensibleLineWidth(<args>)

function! TrimTrailingWhitespace()
  let l:save = winsaveview()
  %s/\s\+$//ge
  call winrestview(l:save)
endfunction
command! TrimTrailingWhitespace call TrimTrailingWhitespace()
nnoremap <silent> <leader>w <cmd>TrimTrailingWhitespace<CR>

function! VisualSearch(direction) abort
  let save_unnamed_reg = getreg('"')
  let save_unnamed_type = getregtype('"')
  let save_search_reg = getreg('/')
  let save_hlsearch = &hlsearch

  try
    silent normal! gv"sy

    let raw_pattern = getreg('s')

    if empty(raw_pattern)
      echohl WarningMsg | echo "Visual selection is empty." | echohl None
      return
    endif

    let escaped_pattern = escape(raw_pattern, '\' . a:direction)

    let final_pattern = substitute(escaped_pattern, '\n', '\\_.', 'g')
    let final_pattern = '\V' . final_pattern

    " echom "[DEBUG] Search Pattern: " . string(final_pattern)
    call setreg('/', final_pattern)
    set hlsearch

    execute "normal!" a:direction . "\<Esc>"

  finally
    call setreg('"', save_unnamed_reg, save_unnamed_type)
  endtry
endfunction
vnoremap <silent> * :<C-U>call VisualSearch('/')<CR>
vnoremap <silent> # :<C-U>call VisualSearch('?')<CR>

let g:temp_dir = $HOME . '/.vim/tmp'
if !isdirectory(g:temp_dir) | call mkdir(g:temp_dir, '', 0700) | endif
com! TempBuf exe 'enew | set filetype=markdown | file ' . g:temp_dir . '/' . strftime('%Y%m%d%H%M%S') . '.md'
nnoremap <leader>t <cmd>TempBuf<CR>

function! RipgrepFzf(query, fullscreen)
  let command_fmt = 'rg --column --line-number --no-heading --color=always --smart-case -- %s || true'
  let initial_command = printf(command_fmt, shellescape(a:query))
  let reload_command = printf(command_fmt, '{q}')
  let spec = {'options': ['--phony', '--query', a:query, '--bind', 'change:reload:'.reload_command]}
  call fzf#vim#grep(initial_command, 1, fzf#vim#with_preview(spec), a:fullscreen)
endfunction

command! -nargs=* -bang RG call RipgrepFzf(<q-args>, <bang>0)

" =================================================================================================
"            ░██                               ░██                             ░██
"            ░██                               ░██                             ░██
"  ░███████  ░████████   ░███████  ░██░████ ░████████  ░███████  ░██    ░██ ░████████  ░███████
" ░██        ░██    ░██ ░██    ░██ ░███        ░██    ░██    ░██ ░██    ░██    ░██    ░██
"  ░███████  ░██    ░██ ░██    ░██ ░██         ░██    ░██        ░██    ░██    ░██     ░███████
"        ░██ ░██    ░██ ░██    ░██ ░██         ░██    ░██    ░██ ░██   ░███    ░██           ░██
"  ░███████  ░██    ░██  ░███████  ░██          ░████  ░███████   ░█████░██     ░████  ░███████

vnoremap J :m '>+1<CR>gv=gv
vnoremap K :m '<-2<CR>gv=gv

nnoremap J mzJ`z
nnoremap n nzzzv
nnoremap N Nzzzv

vnoremap < <gv
vnoremap > >gv

vnoremap <leader>d "+d
nnoremap <leader>d "+d
" Over SSH, or in a Vim built without a clipboard, yank through the terminal (OSC 52).
" SSH_CONNECTION rather than SSH_TTY: tmux refreshes it for new panes on every attach.
" has('clipboard_working') is no use here: it stays 0 until after the vimrc has loaded.
" <Plug> needs a recursive map in older Vims.
if !empty($SSH_CONNECTION) || !has('clipboard')
  vmap <leader>y <Plug>OSCYankVisual
  nmap <leader>y <Plug>OSCYankOperator
else
  vnoremap <leader>y "+y
  nnoremap <leader>y "+y
endif
vnoremap <leader>p "+p
nnoremap <leader>p "+p

nnoremap <leader>s <cmd>%s/\<<C-r><C-w>\>/<C-r><C-w>/gI<Left><Left><Left>

let $FZF_DEFAULT_COMMAND = 'fd --type f --hidden --follow --exclude .git'
nnoremap <leader>r <cmd>RG<CR>
nnoremap <leader>f <cmd>Files<CR>
nnoremap <leader>b <cmd>Buffers<CR>
nnoremap <leader>l <cmd>BLines<CR>
nnoremap <leader>h <cmd>History<CR>
nnoremap <leader>e <cmd>Lexplore<CR>
nnoremap <leader>u <cmd>UndotreeToggle<CR>
nnoremap <leader>g <cmd>Git<CR>

nnoremap <leader>= <cmd>Goyo<CR>
nnoremap <leader><Bar> <cmd>call <SID>ToggleTable()<CR>

" =================================================================================================
