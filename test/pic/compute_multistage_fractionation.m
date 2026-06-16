function [newt, alp, info, cdfa_n, cdfb_n] = compute_multistage_fractionation(t, cdfa, cdfb, n, varargin)
%COMPUTE_MULTISTAGE_FRACTIONATION Compute n-stage fractionation from two CDFs.
%
% Usage:
%   [newt, alp] = compute_multistage_fractionation(t, cdfa, cdfb, n)
%   [newt, alp] = compute_multistage_fractionation(t, cdfa, cdfb, n, dt)
%   [newt, alp] = compute_multistage_fractionation(t, cdfa, cdfb, n, outputType)
%   [newt, alp] = compute_multistage_fractionation(t, cdfa, cdfb, n, dt, outputType)
%   [newt, alp, info, cdfa_n, cdfb_n] = compute_multistage_fractionation(...)
%
% Inputs:
%   t      : time samples.
%   cdfa   : single-stage CDF for species A.
%   cdfb   : single-stage CDF for species B.
%   n      : number of serial stages.
%
% Outputs:
%   newt   : uniform time grid used internally.
%   alp    : n-stage fractionation factor, B/A.
%   info   : diagnostics.
%   cdfa_n : n-stage convolved CDF for A.
%   cdfb_n : n-stage convolved CDF for B.
%
% Important implementation detail:
%   Large n is evaluated using probability masses, not pdf amplitudes:
%
%       mass_n = ifft(fft(mass_1).^n)
%
%   This is equivalent to discrete n-fold convolution on the uniform grid,
%   but avoids overflow from fft(pdf).^n * dt^(n-1).
%
% Optional support-window controls:
%   'stage_time_window', [t0 t1]
%       Crop each single-stage CDF to the absolute time interval [t0, t1],
%       renormalize the retained mass, convolve the cropped distribution,
%       and shift the n-stage output time axis by n*t0.
%
%   'stage_cdf_window', [q0 q1]
%       Choose a common [t0, t1] from the q0/q1 quantiles of both input
%       CDFs, then apply the same crop as 'stage_time_window'.

if nargin < 4
    error('compute_multistage_fractionation requires at least four inputs: t, cdfa, cdfb, and n.');
end

dt = [];
outputType = 'cdf';
rest = varargin;

if ~isempty(rest)
    arg1 = rest{1};
    if isnumeric(arg1) && isscalar(arg1) && isfinite(arg1) && arg1 > 0
        dt = arg1;
        rest = rest(2:end);
    elseif (ischar(arg1) || isstring(arg1)) && any(strcmpi(char(arg1), {'pdf', 'cdf'}))
        outputType = lower(char(arg1));
        rest = rest(2:end);
    end
end

if ~isempty(rest)
    arg1 = rest{1};
    if (ischar(arg1) || isstring(arg1)) && any(strcmpi(char(arg1), {'pdf', 'cdf'}))
        outputType = lower(char(arg1));
        rest = rest(2:end);
    end
end

p = inputParser;
p.FunctionName = 'compute_multistage_fractionation';

addParameter(p, 'left_noise_tol', 1e-4, @(x) isnumeric(x) && isscalar(x) && isfinite(x) && x >= 0);
addParameter(p, 'left_noise_min_run', 3, @(x) isnumeric(x) && isscalar(x) && isfinite(x) && x >= 1);
addParameter(p, 'normalize_input', true, @(x) islogical(x) && isscalar(x));
addParameter(p, 'enforce_monotonic', true, @(x) islogical(x) && isscalar(x));
addParameter(p, 'force_zero_origin', true, @(x) islogical(x) && isscalar(x));
addParameter(p, 'interp_method', 'linear', @(x) ischar(x) || isstring(x));
addParameter(p, 'eps_val', 1e-18, @(x) isnumeric(x) && isscalar(x) && isfinite(x) && x > 0);
addParameter(p, 'tail_factor', [], @(x) isempty(x) || (isnumeric(x) && isscalar(x) && isfinite(x) && x > 0));
addParameter(p, 'stage_time_window', [], @(x) isempty(x) || (isnumeric(x) && numel(x) == 2 && all(isfinite(x(:))) && x(2) > x(1)));
addParameter(p, 'stage_cdf_window', [], @(x) isempty(x) || (isnumeric(x) && numel(x) == 2 && all(isfinite(x(:))) && x(1) >= 0 && x(2) <= 1 && x(2) > x(1)));
addParameter(p, 'max_grid_points', 2^20, @(x) isnumeric(x) && isscalar(x) && isfinite(x) && x >= 1024);
addParameter(p, 'max_fft_points', 2^24, @(x) isnumeric(x) && isscalar(x) && isfinite(x) && x >= 4096);
addParameter(p, 'max_memory_mb', 1024, @(x) isempty(x) || (isnumeric(x) && isscalar(x) && isfinite(x) && x > 0));
addParameter(p, 'show_plot', false, @(x) islogical(x) && isscalar(x));
addParameter(p, 'verbose', true, @(x) islogical(x) && isscalar(x));

parse(p, rest{:});

left_noise_tol = p.Results.left_noise_tol;
left_noise_min_run = max(1, round(p.Results.left_noise_min_run));
normalize_input = p.Results.normalize_input;
enforce_monotonic = p.Results.enforce_monotonic;
force_zero_origin = p.Results.force_zero_origin;
interp_method = char(p.Results.interp_method);
eps_val = p.Results.eps_val;
tail_factor = p.Results.tail_factor;
stage_time_window = p.Results.stage_time_window;
stage_cdf_window = p.Results.stage_cdf_window;
max_grid_points = round(p.Results.max_grid_points);
max_fft_points = round(p.Results.max_fft_points);
max_memory_mb = p.Results.max_memory_mb;
show_plot = p.Results.show_plot;
verbose = p.Results.verbose;

if isempty(tail_factor)
    tail_factor = n + 1;
end

if ~(isnumeric(n) && isscalar(n) && isfinite(n) && n >= 1 && abs(n - round(n)) < 1e-12)
    error('n must be a positive integer.');
end
n = round(n);

outputType = lower(char(outputType));
if ~any(strcmp(outputType, {'pdf', 'cdf'}))
    error('outputType must be ''pdf'' or ''cdf''.');
end

t = t(:);
cdfa = cdfa(:);
cdfb = cdfb(:);

if numel(t) ~= numel(cdfa) || numel(t) ~= numel(cdfb)
    error('t, cdfa, and cdfb must have the same number of elements.');
end

valid_mask = isfinite(t) & isfinite(cdfa) & isfinite(cdfb);
if ~all(valid_mask)
    if verbose
        warning('[compute_multistage_fractionation] non-finite samples detected; removed %d points.', sum(~valid_mask));
    end
    t = t(valid_mask);
    cdfa = cdfa(valid_mask);
    cdfb = cdfb(valid_mask);
end

if numel(t) < 2
    error('Not enough valid samples remain after removing non-finite values.');
end

[t, idx] = sort(t);
cdfa = cdfa(idx);
cdfb = cdfb(idx);

[tu, ~, ic] = unique(t);
if numel(tu) < numel(t)
    if verbose
        warning('[compute_multistage_fractionation] repeated time points detected; CDF values at the same time are averaged.');
    end
    cdfa = accumarray(ic, cdfa, [numel(tu), 1], @mean);
    cdfb = accumarray(ic, cdfb, [numel(tu), 1], @mean);
    t = tu;
end

if any(cdfa < 0)
    if verbose
        warning('[compute_multistage_fractionation] negative values detected in cdfa; clipped to 0.');
    end
    cdfa(cdfa < 0) = 0;
end

if any(cdfb < 0)
    if verbose
        warning('[compute_multistage_fractionation] negative values detected in cdfb; clipped to 0.');
    end
    cdfb(cdfb < 0) = 0;
end

if any(t < 0)
    neg_mask = t < 0;
    max_neg_cdf = max([cdfa(neg_mask); cdfb(neg_mask)]);
    if max_neg_cdf <= max(left_noise_tol, 1e-8)
        if verbose
            warning('[compute_multistage_fractionation] negative-time samples with near-zero CDF detected; removed.');
        end
        t = t(~neg_mask);
        cdfa = cdfa(~neg_mask);
        cdfb = cdfb(~neg_mask);
    else
        shift_amt = -t(1);
        t = t + shift_amt;
        if verbose
            warning('[compute_multistage_fractionation] significant negative-time samples detected; time axis shifted by %.6g.', shift_amt);
        end
    end
end

if numel(t) < 2
    error('Not enough points remain after negative-time processing.');
end

if force_zero_origin
    if t(1) > 0
        t = [0; t];
        cdfa = [0; cdfa];
        cdfb = [0; cdfb];
    elseif abs(t(1)) > 0
        t = t - t(1);
    end
end

cdfa_clean = i_clean_single_cdf(cdfa, left_noise_tol, left_noise_min_run, normalize_input, enforce_monotonic, verbose, 'cdfa');
cdfb_clean = i_clean_single_cdf(cdfb, left_noise_tol, left_noise_min_run, normalize_input, enforce_monotonic, verbose, 'cdfb');

stage_time_offset = 0;
stage_window_applied = false;
stage_window_abs = [];
stage_window_source = 'none';
stage_lower_tail_a = 0;
stage_upper_tail_a = 0;
stage_lower_tail_b = 0;
stage_upper_tail_b = 0;
stage_retained_mass_a = 1;
stage_retained_mass_b = 1;

if ~isempty(stage_cdf_window)
    if ~isempty(stage_time_window)
        error('Use either stage_time_window or stage_cdf_window, not both.');
    end

    q0 = stage_cdf_window(1);
    q1 = stage_cdf_window(2);
    a0 = i_cdf_quantile(t, cdfa_clean, q0);
    a1 = i_cdf_quantile(t, cdfa_clean, q1);
    b0 = i_cdf_quantile(t, cdfb_clean, q0);
    b1 = i_cdf_quantile(t, cdfb_clean, q1);
    stage_time_window = [min(a0, b0), max(a1, b1)];
    stage_window_source = 'stage_cdf_window';
end

if ~isempty(stage_time_window)
    if strcmp(stage_window_source, 'none')
        stage_window_source = 'stage_time_window';
    end

    [t, cdfa_clean, cdfb_clean, stage_diag] = i_apply_stage_time_window( ...
        t, cdfa_clean, cdfb_clean, stage_time_window(:).', interp_method);

    stage_time_offset = stage_diag.t0;
    stage_window_abs = stage_diag.window_abs;
    stage_window_applied = true;
    stage_lower_tail_a = stage_diag.lower_tail_a;
    stage_upper_tail_a = stage_diag.upper_tail_a;
    stage_lower_tail_b = stage_diag.lower_tail_b;
    stage_upper_tail_b = stage_diag.upper_tail_b;
    stage_retained_mass_a = stage_diag.retained_mass_a;
    stage_retained_mass_b = stage_diag.retained_mass_b;

    if verbose
        fprintf(['[compute_multistage_fractionation] %s applied: single-stage window=[%.6g, %.6g], ', ...
            'retained mass A=%.12g, B=%.12g\n'], ...
            stage_window_source, stage_window_abs(1), stage_window_abs(2), ...
            stage_retained_mass_a, stage_retained_mass_b);
    end

    lost_mass_a = stage_lower_tail_a + stage_upper_tail_a;
    lost_mass_b = stage_lower_tail_b + stage_upper_tail_b;
    max_expected_lost_events = n * max(lost_mass_a, lost_mass_b);
    if verbose && max_expected_lost_events > 1e-3
        warning(['[compute_multistage_fractionation] stage window excludes non-negligible per-stage mass ', ...
            '(n*lost_mass=%.6g). The n-stage CDF is conditional on the retained window, ', ...
            'not the full-tail convolution.'], max_expected_lost_events);
    end
end

t_support = t(end);
if ~(isfinite(t_support) && t_support > 0)
    error('Time support must end at a positive value after cleaning.');
end

t_max_ext = t_support * tail_factor;
d = diff(t);
d = d(d > 0);
if isempty(d)
    error('Time sequence must contain at least two distinct points.');
end

d_sorted = sort(d);
q10_idx = max(1, ceil(0.10 * numel(d_sorted)));
dt_data = d_sorted(q10_idx);
dt_cap_grid = t_max_ext / max(max_grid_points - 1, 1);
dt_cap_fft = t_max_ext / max(max_fft_points - 1, 1);

if isempty(dt)
    dt = max([dt_data, dt_cap_grid, dt_cap_fft]);
    N_est = floor(t_max_ext / dt) + 1;
    NFFT_est = 2^nextpow2(N_est);
    estimated_memory_mb = i_estimate_fft_memory_mb(N_est, NFFT_est);

    if ~isempty(max_memory_mb) && estimated_memory_mb > max_memory_mb
        bytes_per_point = 2 * 16 + 8 * 8;
        N_cap_mem = floor(max_memory_mb * 1024^2 / bytes_per_point);
        N_cap_mem = max(1024, N_cap_mem);
        dt_cap_mem = t_max_ext / max(N_cap_mem - 1, 1);
        dt = max(dt, dt_cap_mem);
        N_est = floor(t_max_ext / dt) + 1;
        NFFT_est = 2^nextpow2(N_est);
        estimated_memory_mb = i_estimate_fft_memory_mb(N_est, NFFT_est);
    end

    if verbose
        fprintf(['[compute_multistage_fractionation] auto dt = %.6g ', ...
            '(dt_data=%.6g, dt_cap_grid=%.6g, dt_cap_fft=%.6g, est_mem=%.1f MB)\n'], ...
            dt, dt_data, dt_cap_grid, dt_cap_fft, estimated_memory_mb);
    end
else
    if ~(isnumeric(dt) && isscalar(dt) && isfinite(dt) && dt > 0)
        error('dt must be a positive scalar when provided.');
    end

    dt_min_allowed = max(dt_cap_grid, dt_cap_fft);
    if dt < dt_min_allowed
        if verbose
            warning('[compute_multistage_fractionation] dt too small; changed from %.6g to %.6g to satisfy grid/FFT limits.', ...
                dt, dt_min_allowed);
        end
        dt = dt_min_allowed;
    end
end

conv_t_rel = (0:dt:t_max_ext).';
newt = n * stage_time_offset + conv_t_rel;
stage_t_grid = stage_time_offset + conv_t_rel;

if numel(conv_t_rel) < 2
    error('The generated uniform time grid is too short.');
end

if verbose
    fprintf('[compute_multistage_fractionation] uniform grid: N=%d, dt=%.6g, t_end=%.6g\n', ...
        numel(newt), dt, newt(end));
end

cdfa_interp = i_interp_cdf(t, cdfa_clean, conv_t_rel, interp_method);
cdfb_interp = i_interp_cdf(t, cdfb_clean, conv_t_rel, interp_method);
cdfa_interp = cummax(min(max(cdfa_interp, 0), 1));
cdfb_interp = cummax(min(max(cdfb_interp, 0), 1));

massa_1 = i_cdf_to_mass(cdfa_interp);
massb_1 = i_cdf_to_mass(cdfb_interp);

sum_massa_1_before = sum(massa_1);
sum_massb_1_before = sum(massb_1);
if ~(isfinite(sum_massa_1_before) && sum_massa_1_before > 0)
    error('Derived probability mass from cdfa has non-positive total mass.');
end
if ~(isfinite(sum_massb_1_before) && sum_massb_1_before > 0)
    error('Derived probability mass from cdfb has non-positive total mass.');
end

massa_1 = massa_1 / sum_massa_1_before;
massb_1 = massb_1 / sum_massb_1_before;
sum_massa_1_after = sum(massa_1);
sum_massb_1_after = sum(massb_1);

pdfa_1 = massa_1 / dt;
pdfb_1 = massb_1 / dt;

if verbose
    fprintf('[compute_multistage_fractionation] single-stage mass sum: A before=%.6g, after=%.6g; B before=%.6g, after=%.6g\n', ...
        sum_massa_1_before, sum_massa_1_after, sum_massb_1_before, sum_massb_1_after);
end

NFFT = 2^nextpow2(numel(newt));
if NFFT > max_fft_points
    error('Internal FFT length %d exceeds max_fft_points %d. Increase dt or max_fft_points.', NFFT, max_fft_points);
end

if verbose
    fprintf('[compute_multistage_fractionation] stable mass FFT: NFFT=%d, n=%d\n', NFFT, n);
end

massa_n = i_nfold_mass_fft(massa_1, n, NFFT, numel(newt), 'A');
massb_n = i_nfold_mass_fft(massb_1, n, NFFT, numel(newt), 'B');

sum_massa_n_before = sum(massa_n);
sum_massb_n_before = sum(massb_n);
if ~(isfinite(sum_massa_n_before) && sum_massa_n_before > 0)
    error('n-stage mass for A is not finite positive. Try larger tail_factor or coarser dt.');
end
if ~(isfinite(sum_massb_n_before) && sum_massb_n_before > 0)
    error('n-stage mass for B is not finite positive. Try larger tail_factor or coarser dt.');
end

massa_n = massa_n / sum_massa_n_before;
massb_n = massb_n / sum_massb_n_before;
sum_massa_n_after = sum(massa_n);
sum_massb_n_after = sum(massb_n);

pdfa_n = massa_n / dt;
pdfb_n = massb_n / dt;
cdfa_n = cumsum(massa_n);
cdfb_n = cumsum(massb_n);
cdfa_n = cummax(min(max(cdfa_n, 0), 1));
cdfb_n = cummax(min(max(cdfb_n, 0), 1));

mom_a_1 = i_mass_moments(stage_t_grid, massa_1);
mom_b_1 = i_mass_moments(stage_t_grid, massb_1);
mom_a_n = i_mass_moments(newt, massa_n);
mom_b_n = i_mass_moments(newt, massb_n);

if verbose
    if mom_a_1.effective_bins < 3 || mom_a_1.std <= 0
        warning(['[compute_multistage_fractionation] A single-stage distribution is resolved by only %.3g effective bins ', ...
            '(dt=%.6g). The CDF/PDF difference may collapse; use stage_time_window/stage_cdf_window ', ...
            'or increase max_grid_points to reduce dt.'], mom_a_1.effective_bins, dt);
    end
    if mom_b_1.effective_bins < 3 || mom_b_1.std <= 0
        warning(['[compute_multistage_fractionation] B single-stage distribution is resolved by only %.3g effective bins ', ...
            '(dt=%.6g). The CDF/PDF difference may collapse; use stage_time_window/stage_cdf_window ', ...
            'or increase max_grid_points to reduce dt.'], mom_b_1.effective_bins, dt);
    end
end

if verbose
    fprintf('[compute_multistage_fractionation] n-stage mass sum: A before=%.6g, after=%.6g; B before=%.6g, after=%.6g\n', ...
        sum_massa_n_before, sum_massa_n_after, sum_massb_n_before, sum_massb_n_after);
end

switch outputType
    case 'pdf'
        baseA = pdfa_n;
        baseB = pdfb_n;
    case 'cdf'
        baseA = cdfa_n;
        baseB = cdfb_n;
end

alp = zeros(size(baseA));
valid_div = isfinite(baseA) & isfinite(baseB) & baseA > eps_val;
alp(valid_div) = baseB(valid_div) ./ baseA(valid_div);

if show_plot
    figure('Position', [100, 100, 1250, 820]);

    subplot(2, 3, 1);
    plot(stage_time_offset + t, cdfa_clean, 'b.', 'DisplayName', 'cleaned/cropped cdfa');
    hold on;
    plot(stage_time_offset + t, cdfa_clean, 'k-', 'LineWidth', 1.1, 'DisplayName', 'cleaned/cropped cdfa');
    xlabel('Time');
    ylabel('CDF');
    title('Input A CDF');
    grid on;
    legend('Location', 'best');

    subplot(2, 3, 2);
    plot(stage_time_offset + t, cdfb_clean, 'r.', 'DisplayName', 'cleaned/cropped cdfb');
    hold on;
    plot(stage_time_offset + t, cdfb_clean, 'k-', 'LineWidth', 1.1, 'DisplayName', 'cleaned/cropped cdfb');
    xlabel('Time');
    ylabel('CDF');
    title('Input B CDF');
    grid on;
    legend('Location', 'best');

    subplot(2, 3, 3);
    plot(stage_t_grid, pdfa_1, 'b-', 'LineWidth', 1.1, 'DisplayName', 'A single PDF');
    hold on;
    plot(stage_t_grid, pdfb_1, 'r-', 'LineWidth', 1.1, 'DisplayName', 'B single PDF');
    xlabel('Time');
    ylabel('PDF');
    title('Single-Stage PDF');
    grid on;
    legend('Location', 'best');

    subplot(2, 3, 4);
    plot(newt, pdfa_n, 'b-', 'LineWidth', 1.1, 'DisplayName', sprintf('A %d-stage PDF', n));
    hold on;
    plot(newt, pdfb_n, 'r-', 'LineWidth', 1.1, 'DisplayName', sprintf('B %d-stage PDF', n));
    xlabel('Time');
    ylabel('PDF');
    title(sprintf('%d-Stage PDF', n));
    grid on;
    legend('Location', 'best');

    subplot(2, 3, 5);
    plot(newt, cdfa_n, 'b-', 'LineWidth', 1.1, 'DisplayName', 'A CDF');
    hold on;
    plot(newt, cdfb_n, 'r-', 'LineWidth', 1.1, 'DisplayName', 'B CDF');
    xlabel('Time');
    ylabel('CDF');
    title(sprintf('%d-Stage CDF', n));
    grid on;
    legend('Location', 'best');

    subplot(2, 3, 6);
    plot(newt, alp, 'k-', 'LineWidth', 1.4, 'DisplayName', '\alpha_n');
    xlabel('Time');
    ylabel('\alpha_n');
    title('Fractionation Factor');
    grid on;
    legend('Location', 'best');
end

info = struct();
info.n_stage = n;
info.dt = dt;
info.outputType = outputType;
info.interp_method = interp_method;
info.eps_val = eps_val;
info.tail_factor = tail_factor;
info.stage_time_window = stage_window_abs;
info.stage_time_window_source = stage_window_source;
info.stage_window_applied = stage_window_applied;
info.stage_time_offset = stage_time_offset;
info.stage_t_grid = stage_t_grid;
info.conv_t_rel = conv_t_rel;
info.stage_lower_tail_a = stage_lower_tail_a;
info.stage_upper_tail_a = stage_upper_tail_a;
info.stage_lower_tail_b = stage_lower_tail_b;
info.stage_upper_tail_b = stage_upper_tail_b;
info.stage_retained_mass_a = stage_retained_mass_a;
info.stage_retained_mass_b = stage_retained_mass_b;
info.max_grid_points = max_grid_points;
info.max_fft_points = max_fft_points;
info.max_memory_mb = max_memory_mb;
info.t_clean = t;
info.cdfa_clean = cdfa_clean;
info.cdfb_clean = cdfb_clean;
info.cdfa_interp = cdfa_interp;
info.cdfb_interp = cdfb_interp;
info.massa_1 = massa_1;
info.massb_1 = massb_1;
info.pdfa_1 = pdfa_1;
info.pdfb_1 = pdfb_1;
info.massa_n = massa_n;
info.massb_n = massb_n;
info.pdfa_n = pdfa_n;
info.pdfb_n = pdfb_n;
info.cdfa_n = cdfa_n;
info.cdfb_n = cdfb_n;
info.mom_a_1 = mom_a_1;
info.mom_b_1 = mom_b_1;
info.mom_a_n = mom_a_n;
info.mom_b_n = mom_b_n;
info.std_ratio_a = i_safe_ratio(mom_a_n.std, sqrt(n) * mom_a_1.std);
info.std_ratio_b = i_safe_ratio(mom_b_n.std, sqrt(n) * mom_b_1.std);
info.cv_shrink_a = i_safe_ratio(mom_a_n.cv, mom_a_1.cv);
info.cv_shrink_b = i_safe_ratio(mom_b_n.cv, mom_b_1.cv);
info.baseA = baseA;
info.baseB = baseB;
info.alpha = alp;
info.sum_massa_1_before = sum_massa_1_before;
info.sum_massa_1_after = sum_massa_1_after;
info.sum_massb_1_before = sum_massb_1_before;
info.sum_massb_1_after = sum_massb_1_after;
info.sum_massa_n_before = sum_massa_n_before;
info.sum_massa_n_after = sum_massa_n_after;
info.sum_massb_n_before = sum_massb_n_before;
info.sum_massb_n_after = sum_massb_n_after;
info.area_pdfa_1_trapz = trapz(newt, pdfa_1);
info.area_pdfb_1_trapz = trapz(newt, pdfb_1);
info.area_pdfa_n_trapz = trapz(newt, pdfa_n);
info.area_pdfb_n_trapz = trapz(newt, pdfb_n);
info.NFFT = NFFT;
info.estimated_fft_memory_mb = i_estimate_fft_memory_mb(numel(newt), NFFT);

if verbose
    fprintf('[compute_multistage_fractionation] done. n=%d, dt=%.6g, outputType=%s\n', n, dt, outputType);
end

end

function cdf_clean = i_clean_single_cdf(cdf_in, left_noise_tol, left_noise_min_run, normalize_input, enforce_monotonic, verbose, tag)
cdf_clean = cdf_in(:);
cdf_clean(cdf_clean < 0) = 0;
cdf_clean(cdf_clean > 1) = 1;

if normalize_input
    cdf_max = max(cdf_clean);
    if cdf_max <= 0
        error('Input %s has non-positive maximum after cleaning.', tag);
    end
    if verbose && abs(cdf_max - 1) > 1e-3
        fprintf('[compute_multistage_fractionation] %s max = %.6g, normalized to 1.\n', tag, cdf_max);
    end
    cdf_clean = cdf_clean / cdf_max;
end

rise_idx = i_find_first_real_rise_after_left_drop(cdf_clean, left_noise_tol, left_noise_min_run);
if isempty(rise_idx)
    rise_idx = i_find_first_persistent_rise(cdf_clean, left_noise_tol, left_noise_min_run);
end

if ~isempty(rise_idx) && rise_idx > 1
    if verbose
        fprintf('[compute_multistage_fractionation] %s left-side pre-rise segment set to 0 before index %d.\n', ...
            tag, rise_idx);
    end
    cdf_clean(1:rise_idx - 1) = 0;
else
    cdf_clean(cdf_clean < left_noise_tol) = 0;
end

if enforce_monotonic
    cdf_clean = cummax(cdf_clean);
end

cdf_clean(cdf_clean < 0) = 0;
cdf_clean(cdf_clean > 1) = 1;

if normalize_input
    cdf_end = cdf_clean(end);
    if cdf_end <= 0
        error('Cleaned %s ends at a non-positive value; cannot normalize.', tag);
    end
    cdf_clean = cdf_clean / cdf_end;
    cdf_clean(cdf_clean > 1) = 1;
end

if cdf_clean(1) <= max(left_noise_tol, 1e-8)
    cdf_clean(1) = 0;
end

if enforce_monotonic
    cdf_clean = cummax(cdf_clean);
end
end

function idx = i_find_first_persistent_rise(cdf_vals, tol, min_run)
idx = [];
n_vals = numel(cdf_vals);
if n_vals == 0
    return;
end

min_run = max(1, min(min_run, n_vals));
for k = 1:(n_vals - min_run + 1)
    if all(cdf_vals(k:(k + min_run - 1)) >= tol)
        idx = k;
        return;
    end
end
end

function idx = i_find_first_real_rise_after_left_drop(cdf_vals, tol, min_run)
idx = [];
cdf_vals = cdf_vals(:);
n_vals = numel(cdf_vals);
if n_vals < max(3, min_run + 1)
    return;
end

tol_eff = max(tol, 1e-12);
diff_vals = diff(cdf_vals);
drop_tol = max(tol_eff * 0.1, 1e-14);

% This handles artifacts like a large left value that decays to numerical
% noise before the real CDF rise. Plain cummax would otherwise preserve it.
has_left_drop = false;
drop_end = 1;
for k = 1:numel(diff_vals)
    if diff_vals(k) < -drop_tol
        has_left_drop = true;
        drop_end = k + 1;
    elseif has_left_drop && cdf_vals(k + 1) <= tol_eff
        drop_end = k + 1;
    elseif has_left_drop
        break;
    end
end

if ~has_left_drop
    return;
end

search_start = max(1, drop_end);
min_run = max(1, min(min_run, n_vals));
for k = search_start:(n_vals - min_run + 1)
    run_vals = cdf_vals(k:(k + min_run - 1));
    if all(run_vals >= tol_eff) && all(diff(run_vals) >= -drop_tol)
        idx = k;
        return;
    end
end
end

function yq = i_interp_cdf(x, y, xq, method)
x = x(:);
y = y(:);
xq = xq(:);

yq = zeros(size(xq));
inside = (xq >= x(1)) & (xq <= x(end));
right = xq > x(end);

if any(inside)
    yq(inside) = interp1(x, y, xq(inside), method);
end
yq(right) = 1;

yq(yq < 0) = 0;
yq(yq > 1) = 1;
end

function tq = i_cdf_quantile(t, cdf_vals, q)
t = t(:);
cdf_vals = cummax(min(max(cdf_vals(:), 0), 1));

if q <= cdf_vals(1)
    tq = t(1);
    return;
end
if q >= cdf_vals(end)
    tq = t(end);
    return;
end

[cdf_u, ia] = unique(cdf_vals, 'stable');
t_u = t(ia);
if numel(cdf_u) < 2
    tq = t(1);
else
    tq = interp1(cdf_u, t_u, q, 'linear', 'extrap');
end
end

function [t_rel, cdfa_crop, cdfb_crop, diag] = i_apply_stage_time_window(t, cdfa, cdfb, window_abs, method)
t = t(:);
cdfa = cummax(min(max(cdfa(:), 0), 1));
cdfb = cummax(min(max(cdfb(:), 0), 1));

t0 = max(window_abs(1), t(1));
t1 = min(window_abs(2), t(end));
if ~(isfinite(t0) && isfinite(t1) && t1 > t0)
    error('stage_time_window must overlap the input time support with positive length.');
end

cdfa0 = i_interp_cdf(t, cdfa, t0, method);
cdfa1 = i_interp_cdf(t, cdfa, t1, method);
cdfb0 = i_interp_cdf(t, cdfb, t0, method);
cdfb1 = i_interp_cdf(t, cdfb, t1, method);

retained_a = cdfa1 - cdfa0;
retained_b = cdfb1 - cdfb0;
if ~(isfinite(retained_a) && retained_a > 0)
    error('stage_time_window retains non-positive mass for cdfa.');
end
if ~(isfinite(retained_b) && retained_b > 0)
    error('stage_time_window retains non-positive mass for cdfb.');
end

inside = t > t0 & t < t1;
t_abs = [t0; t(inside); t1];
cdfa_abs = [cdfa0; cdfa(inside); cdfa1];
cdfb_abs = [cdfb0; cdfb(inside); cdfb1];

cdfa_crop = (cdfa_abs - cdfa0) / retained_a;
cdfb_crop = (cdfb_abs - cdfb0) / retained_b;
cdfa_crop = cummax(min(max(cdfa_crop, 0), 1));
cdfb_crop = cummax(min(max(cdfb_crop, 0), 1));
cdfa_crop(1) = 0;
cdfb_crop(1) = 0;
cdfa_crop(end) = 1;
cdfb_crop(end) = 1;

t_rel = t_abs - t0;

diag = struct();
diag.t0 = t0;
diag.t1 = t1;
diag.window_abs = [t0, t1];
diag.lower_tail_a = cdfa0;
diag.upper_tail_a = 1 - cdfa1;
diag.lower_tail_b = cdfb0;
diag.upper_tail_b = 1 - cdfb1;
diag.retained_mass_a = retained_a;
diag.retained_mass_b = retained_b;
end

function mass = i_cdf_to_mass(cdf_vals)
cdf_vals = cdf_vals(:);
cdf_vals = cummax(min(max(cdf_vals, 0), 1));
mass = [cdf_vals(1); diff(cdf_vals)];
mass(~isfinite(mass)) = 0;
mass(mass < 0) = 0;
end

function mass_n = i_nfold_mass_fft(mass_1, n, NFFT, out_len, tag)
mass_1 = mass_1(:);
F = fft(mass_1, NFFT);
F = F .^ n;
mass_full = real(ifft(F));
mass_n = mass_full(1:out_len);
mass_n(~isfinite(mass_n)) = 0;

neg_tol = 1e-12 * max(1, max(abs(mass_n)));
mass_n(mass_n < 0 & mass_n > -neg_tol) = 0;
if any(mass_n < 0)
    warning('[compute_multistage_fractionation] %s n-stage mass has significant negative numerical values; clipped to 0.', tag);
    mass_n(mass_n < 0) = 0;
end
end

function mom = i_mass_moments(x, mass)
x = x(:);
mass = mass(:);
mass(~isfinite(mass)) = 0;
mass(mass < 0) = 0;
mass_sum = sum(mass);

mom = struct();
mom.mass_sum = mass_sum;
mom.mean = NaN;
mom.std = NaN;
mom.cv = NaN;
mom.effective_bins = 0;
mom.nonzero_bins = 0;

if ~(isfinite(mass_sum) && mass_sum > 0)
    return;
end

p = mass / mass_sum;
mom.nonzero_bins = sum(p > 0);
mom.effective_bins = 1 / sum(p .^ 2);
mom.mean = sum(x .* p);
var_val = sum(((x - mom.mean) .^ 2) .* p);
var_val = max(var_val, 0);
mom.std = sqrt(var_val);
if mom.mean ~= 0
    mom.cv = mom.std / abs(mom.mean);
end
end

function r = i_safe_ratio(num, den)
if isfinite(num) && isfinite(den) && den > 0
    r = num / den;
else
    r = NaN;
end
end

function mb = i_estimate_fft_memory_mb(N, NFFT)
mb = (2 * NFFT * 16 + 8 * N * 8) / 1024^2;
end
