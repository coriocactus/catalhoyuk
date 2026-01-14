" =================================================================================================
let g:copilot_enabled = v:false
"
" headings:
" https://patorjk.com/software/taag/#p=display&f=Terrace&t=.vimrc&x=none&v=4&h=4&w=80&we=false
"
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
execute 'set directory=' . SWAP_DIR . '//'
execute 'set undodir=' . UNDO_DIR . '//'
execute 'set backupdir=' . BACKUP_DIR . '//'
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

set autoindent

set hidden
set nowrap
set hlsearch
set belloff=all
set signcolumn=yes
set colorcolumn=80
set laststatus=0
set cursorline
set scrolloff=0

set redrawtime=10000

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

autocmd VimEnter * if argc() == 0 | Explore | endif
autocmd BufReadPost,FileReadPost,BufNewFile,BufEnter,FocusGained * call system('tmux rename-window ' . expand('%:t'))
autocmd VimLeave * silent call system("tmux rename-window " . "$(echo $SHELL | awk -F '/' '{print $NF}')")

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

  Plug 'coriocactus/claudia.vim'
  Plug 'github/copilot.vim'
call plug#end()

if empty(glob(VIM_DIR . '/autoload/plug.vim'))
  silent execute '!curl -fLo ' . VIM_DIR . '/autoload/plug.vim --create-dirs ' . 'https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim'
endif

autocmd VimEnter * if len(filter(values(g:plugs), '!isdirectory(v:val.dir)')) | PlugInstall --sync | source $MYVIMRC | endif

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

set omnifunc=ale#completion#OmniFunc
set completeopt=menu,noselect

nnoremap <leader>a <cmd>ALEToggleBuffer<CR>
nnoremap <silent> K <cmd>ALEHover<CR>
nnoremap <silent> [g <cmd>ALENext<CR>
nnoremap <silent> ]g <cmd>ALEPrevious<CR>
nnoremap <silent> gd <cmd>ALEGoToDefinition<CR>
nnoremap <silent> gr <cmd>ALEFindReferences<CR>
nnoremap <silent> ca <cmd>ALECodeAction<CR>

let g:ale_linters = {
      \ 'python': ['pylsp', 'ruff'],
      \ 'haskell': ['hls'],
      \ 'javascript': ['biome', 'tsserver', 'eslint'],
      \ 'javascriptreact': ['biome', 'tsserver', 'eslint'],
      \ 'typescript': ['biome', 'tsserver', 'eslint'],
      \ 'typescriptreact': ['biome', 'tsserver', 'eslint'],
      \ 'html': ['djlint'],
      \ 'css': ['stylelint'],
\}

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

command! -bang -nargs=* Rg call fzf#vim#grep('rg --column --line-number --no-heading --color=always --smart-case ' . shellescape(<q-args>), 2, {'options': '--delimiter : --nth 4..'}, <bang>0)

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

vnoremap <leader>d "+d
nnoremap <leader>d "+d
vnoremap <leader>y "+y
nnoremap <leader>y "+y
vnoremap <leader>p "+p
nnoremap <leader>p "+p

nnoremap <leader>s <cmd>%s/\<<C-r><C-w>\>/<C-r><C-w>/gI<Left><Left><Left>

let $FZF_DEFAULT_COMMAND = 'ag -g ""'
nnoremap <leader>r <cmd>Rg<CR>
nnoremap <leader>f <cmd>Files<CR>
nnoremap <leader>b <cmd>Buffers<CR>
nnoremap <leader>l <cmd>BLines<CR>

nnoremap <leader>g <cmd>Git<CR>

nnoremap <leader>u <cmd>UndotreeToggle<CR>

let s:ssh_config = expand('~/.vimrc-ssh')
if filereadable(s:ssh_config) | execute 'source ' . s:ssh_config | endif

" =================================================================================================
