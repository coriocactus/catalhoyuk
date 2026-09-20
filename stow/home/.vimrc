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
set signcolumn=yes
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
  autocmd BufWinEnter * silent! loadview
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
colorscheme slate
highlight ColorColumn ctermbg=238

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
let g:indentLine_fileTypeExclude = ['json', 'markdown', 'tex']

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
vnoremap <leader>y "+y
nnoremap <leader>y "+y
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

nnoremap <leader>= <cmd>set wrap<CR><cmd>set colorcolumn=<CR>
nnoremap <leader>0 <cmd>set nowrap<CR><cmd>set colorcolumn=80<CR>

let s:ssh_config = expand('~/.vimrc-ssh')
if filereadable(s:ssh_config) | execute 'source ' . fnameescape(s:ssh_config) | endif

" =================================================================================================
