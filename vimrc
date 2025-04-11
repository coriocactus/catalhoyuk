" .vimrc

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

syntax on

colorscheme slate
highlight ColorColumn ctermbg=238

if $TERM=='screen-256color' | set ttymouse=xterm2 | endif

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

nnoremap <leader>s :%s/\<<C-r><C-w>\>/<C-r><C-w>/gI<Left><Left><Left>

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
nnoremap <leader>w :TrimTrailingWhitespace<CR>

let g:temp_dir = $HOME . '/.vim/tmp'
if !isdirectory(g:temp_dir) | call mkdir(g:temp_dir, '', 0700) | endif
com! TempBuf exe 'enew | set filetype=markdown | file ' . g:temp_dir . '/' . strftime('%Y%m%d%H%M%S') . '.md'
nnoremap <leader>t :TempBuf<CR>

call plug#begin()
Plug 'sheerun/vim-polyglot'
Plug 'prabirshrestha/vim-lsp'
Plug 'mattn/vim-lsp-settings'
Plug 'dense-analysis/ale'
Plug 'rhysd/vim-lsp-ale'
Plug 'prabirshrestha/asyncomplete.vim'
Plug 'prabirshrestha/asyncomplete-lsp.vim'
Plug 'junegunn/fzf', { 'do': { -> fzf#install() } }
Plug 'junegunn/fzf.vim'
Plug 'mbbill/undotree'
Plug 'markonm/traces.vim'
Plug 'yggdroot/indentline'
Plug 'tpope/vim-fugitive'
Plug 'github/copilot.vim'
Plug 'coriocactus/claudia.vim'
Plug 'ojroques/vim-oscyank', {'branch': 'main'}
call plug#end()

if empty(glob(VIM_DIR . '/autoload/plug.vim'))
    silent execute '!curl -fLo '
                \ . VIM_DIR
                \ . '/autoload/plug.vim --create-dirs '
                \ . 'https://raw.githubusercontent.com/'
                \ . 'junegunn/vim-plug/master/plug.vim'
endif

autocmd VimEnter *
            \ if len(filter(values(g:plugs), '!isdirectory(v:val.dir)')) |
            \   PlugInstall --sync |
            \   source $MYVIMRC |
            \ endif

function! s:on_lsp_buffer_enabled() abort
    setlocal omnifunc=lsp#complete
    setlocal signcolumn=yes
    if exists('+tagfunc') | setlocal tagfunc=lsp#tagfunc | endif
    nmap <buffer> gd <plug>(lsp-definition)
    nmap <buffer> gs <plug>(lsp-document-symbol-search)
    nmap <buffer> gS <plug>(lsp-workspace-symbol-search)
    nmap <buffer> gr <plug>(lsp-references)
    nmap <buffer> gi <plug>(lsp-implementation)
    nmap <buffer> gt <plug>(lsp-type-definition)
    nmap <buffer> <leader>rn <plug>(lsp-rename)
    nmap <buffer> <leader>d <plug>(lsp-document-diagnostics)
    nmap <buffer> K <plug>(lsp-hover)
    nnoremap <buffer> <expr><c-n> lsp#scroll(+4)
    nnoremap <buffer> <expr><c-p> lsp#scroll(-4)
    let g:lsp_format_sync_timeout = 1000
    autocmd! BufWritePre *.rs,*.go call execute('LspDocumentFormatSync')
endfunction

augroup lsp_install
    au!
    autocmd User lsp_buffer_enabled call s:on_lsp_buffer_enabled()
augroup END

nmap <silent> [g :ALENext<CR>
nmap <silent> ]g :ALEPrevious<CR>
let g:python_recommended_style = 0
let g:ale_fixers = {'python': ['ruff']}
let g:ale_linters = {
            \ 'python': [
            \   'ruff'
            \ ],
            \ 'haskell': [
            \   'cabal_ghc',
            \   'cspell',
            \   'ghc_mod',
            \   'hdevtools',
            \   'hie',
            \   'hlint',
            \   'hls',
            \   'stack_build',
            \   'stack_ghc'
            \ ],
            \ }

command! -bang -nargs=* Rg
            \ call fzf#vim#grep(
            \   'rg --column --line-number --no-heading '
            \   . '--color=always --smart-case '
            \   . shellescape(<q-args>),
            \   2,
            \   {
            \     'options': '--delimiter : --nth 4..'
            \   },
            \   <bang>0
            \ )

nnoremap <leader>r :Rg<CR>
nnoremap <leader>f :Files<CR>
nnoremap <leader>b :Buffers<CR>
nnoremap <leader>l :BLines<CR>

nnoremap <leader>g :Git<CR>

nnoremap <leader>u :UndotreeToggle<CR>
let g:undotree_SetFocusWhenToggle = 1

let g:indentLine_fileTypeExclude = ['json', 'markdown']

autocmd VimEnter * if argc() == 0 | Explore | endif

autocmd BufReadPost,FileReadPost,BufNewFile,BufEnter,FocusGained *
            \ call system(
            \   'tmux rename-window '
            \   . expand('%:t')
            \ )

autocmd VimLeave *
            \ silent call system(
            \   "tmux rename-window "
            \   . "$(echo $SHELL | awk -F '/' '{print $NF}')"
            \ )

let s:ssh_config = expand('~/.vimrc-ssh')
if filereadable(s:ssh_config) | execute 'source ' . s:ssh_config | endif

" let g:copilot_enabled = v:false
